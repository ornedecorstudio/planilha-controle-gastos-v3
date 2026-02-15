/**
 * Pipeline Santander — Fatura de Cartao de Credito
 *
 * Santander SEMPRE requer IA visual por causa do layout columnar.
 * Quando pdf-parse extrai o texto, datas/descricoes ficam em um bloco
 * e valores em outro bloco separado, gerando corrupcao nos valores.
 *
 * Exemplo real do texto extraido:
 *   "16/12 SEG CONTA CART - DEZ/25 17/12 SEG CONTA CART - DEZ/25 VALOR TOTAL"
 *   "Parcela"
 *   "R$    US$"
 *   "10,69"
 *   "25,39"
 *
 * Multiplas transacoes concatenadas + valores separados = regex impossivel.
 *
 * Estrategia:
 *   1. Extrai metadados confiaveis do texto (total da fatura, cartoes, resumo)
 *   2. NAO tenta capturar transacoes (impossivel com texto columnar)
 *   3. SEMPRE retorna needsAI: true para forcar IA visual
 *   4. IA visual recebe metadados para verificacao cruzada
 *   5. Pos-IA corrige estornos e filtra transacoes invalidas
 *
 * Caracteristicas Santander:
 * - Layout columnar (datas+descricoes separados dos valores)
 * - Multiplos cartoes (titular + adicionais), cada um com secoes proprias
 * - Pagina 1: Resumo (Total a Pagar, Pagamento Minimo, limite, anuidade)
 * - Paginas 2-3: "Detalhamento da Fatura" com transacoes por cartao
 * - Secoes por cartao: "Despesas", "Parcelamentos", "Pagamento e Demais Creditos"
 * - "Seu Limite e:" NAO e transacao (e o limite do cartao)
 * - "PAGAMENTO DE FATURA-INTERNET" NAO e transacao (e pagamento anterior)
 * - "Resumo da Fatura" no final com totais de verificacao
 * - Programa Smiles (milhas) — ignorar
 */

import { parseValorBR, calcularAuditoria, filtrarTransacoesIA, corrigirEstornosIA } from '../utils.js';

// ===== IDENTIFICADOR DO BANCO =====
export const BANK_ID = 'santander';

// ===== FUNCOES DE EXTRACAO DE METADADOS =====

/**
 * Extrai o "Total a Pagar" do resumo da fatura (pagina 1).
 *
 * Santander tem varios valores na pagina 1:
 *   - "Total a Pagar R$ 10.211,65" (este e o correto)
 *   - "1 Pagamento Total R$10.211,65" (mesmo valor, formato diferente)
 *   - "2 Pagamento Minimo R$1.021,16" (NAO e o total)
 *   - "Seu Limite e: R$10.570,00" (NAO e o total, e o limite do cartao)
 *
 * Ordem de prioridade:
 *   1. "Total a Pagar" — mais confiavel
 *   2. "Pagamento Total" — fora de contexto de limite/minimo
 *   3. "Saldo Desta Fatura" — no resumo da pagina 2/3
 */
function extrairTotalFaturaPDF(texto) {
  // Padrao 1: "Total a Pagar R$ 10.211,65"
  const regexTotalPagar = /TOTAL\s+A\s+PAGAR\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i;
  let match = regexTotalPagar.exec(texto);
  if (match) {
    const valor = parseValorBR(match[1]);
    if (valor >= 100) {
      console.log(`[Santander Pipeline] Total extraido via "Total a Pagar": ${valor}`);
      return valor;
    }
  }

  // Padrao 2: "Pagamento Total R$10.211,65" (sem espaco apos R$)
  const regexPagTotal = /PAGAMENTO\s+TOTAL\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i;
  match = regexPagTotal.exec(texto);
  if (match) {
    const valor = parseValorBR(match[1]);
    if (valor >= 100) {
      console.log(`[Santander Pipeline] Total extraido via "Pagamento Total": ${valor}`);
      return valor;
    }
  }

  // Padrao 3: "Saldo Desta Fatura" no resumo (pagina 2/3)
  const regexSaldo = /SALDO\s+DESTA\s+FATURA[\s\S]{0,100}?(\d{1,3}(?:\.\d{3})*,\d{2})/i;
  match = regexSaldo.exec(texto);
  if (match) {
    const valor = parseValorBR(match[1]);
    if (valor >= 100) {
      console.log(`[Santander Pipeline] Total extraido via "Saldo Desta Fatura": ${valor}`);
      return valor;
    }
  }

  console.log('[Santander Pipeline] Nenhum total da fatura encontrado');
  return null;
}

/**
 * Extrai numeros de cartao (ultimos 4 digitos) mencionados no PDF.
 * Padroes Santander: "4258 XXXX XXXX 8172" e "FINAL 8172"
 */
function extrairCartoes(texto) {
  const cartoes = new Set();

  // Padrao "NNNN XXXX XXXX NNNN"
  const regexCartao = /\d{4}\s+XXXX\s+XXXX\s+(\d{4})/gi;
  let match;
  while ((match = regexCartao.exec(texto)) !== null) {
    cartoes.add(match[1]);
  }

  // Fallback: "FINAL NNNN"
  const regexFinal = /FINAL\s+(\d{4})/gi;
  while ((match = regexFinal.exec(texto)) !== null) {
    cartoes.add(match[1]);
  }

  return [...cartoes];
}

/**
 * Extrai valores do "Resumo da Fatura" (pagina 2/3).
 *
 * Santander tem:
 *   Saldo Anterior (+) ... R$ 6.530,92
 *   Total Despesas/Debitos no Brasil (+) ... R$ 10.211,65
 *   Total Despesas/Debitos no Exterior (+) ... R$ 0,00
 *   Total de pagamentos (-) ... R$ 6.530,92
 *   Total de creditos (-) ... R$ 0,00
 *   Saldo Desta Fatura ... R$ 10.211,65
 *
 * NOTA: No texto extraido pelo pdf-parse, os valores ficam separados
 * das descricoes (layout columnar). Tentamos extrair o que for possivel.
 */
function extrairResumoFatura(texto) {
  const resumo = {};

  // Buscar "Total Despesas/Debitos no Brasil"
  const regexDespBR = /TOTAL\s+DESPESAS.*?BRASIL[\s\S]{0,200}?(\d{1,3}(?:\.\d{3})*,\d{2})/i;
  let match = regexDespBR.exec(texto);
  if (match) {
    resumo.total_despesas_brasil = parseValorBR(match[1]);
  }

  // Buscar "Total de pagamentos"
  const regexPag = /TOTAL\s+DE\s+PAGAMENTOS[\s\S]{0,200}?(\d{1,3}(?:\.\d{3})*,\d{2})/i;
  match = regexPag.exec(texto);
  if (match) {
    resumo.total_pagamentos = parseValorBR(match[1]);
  }

  // Buscar "Total de creditos"
  const regexCred = /TOTAL\s+DE\s+CR[EÉ]DITOS[\s\S]{0,200}?(\d{1,3}(?:\.\d{3})*,\d{2})/i;
  match = regexCred.exec(texto);
  if (match) {
    resumo.total_creditos = parseValorBR(match[1]);
  }

  // Buscar "Saldo Anterior"
  const regexSaldoAnt = /SALDO\s+ANTERIOR[\s\S]{0,200}?(\d{1,3}(?:\.\d{3})*,\d{2})/i;
  match = regexSaldoAnt.exec(texto);
  if (match) {
    resumo.saldo_anterior = parseValorBR(match[1]);
  }

  return Object.keys(resumo).length > 0 ? resumo : null;
}

/**
 * Extrai o valor total de anuidade da pagina 1.
 * Santander mostra: "ANUIDADE Entenda como e calculada ... TOTAL R$113,33"
 */
function extrairAnuidade(texto) {
  // Buscar "ANUIDADE" seguido de "TOTAL R$XXX,XX" em ate 500 chars
  const regexAnuidade = /ANUIDADE[\s\S]{0,500}?TOTAL\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i;
  const match = regexAnuidade.exec(texto);
  if (match) {
    const valor = parseValorBR(match[1]);
    if (valor > 0) {
      console.log(`[Santander Pipeline] Anuidade total extraida: ${valor}`);
      return valor;
    }
  }
  return null;
}

/**
 * Detecta se o texto Santander tem layout columnar.
 *
 * Heuristica: conta linhas com multiplas datas DD/MM concatenadas
 * (ex: "16/12 SEG CONTA CART - DEZ/25 17/12 SEG CONTA CART - DEZ/25").
 * Tambem verifica linhas que sao apenas valores sem descricao.
 */
function detectarLayoutColumnar(texto) {
  const linhas = texto.split('\n');
  let linhasComDuasDatas = 0;
  let linhasComUmaData = 0;
  let linhasSoValor = 0;

  for (const linha of linhas) {
    const trimmed = linha.trim();

    // Contar linhas com multiplas datas
    const datas = trimmed.match(/\d{1,2}\/\d{1,2}/g);
    if (datas && datas.length >= 2) {
      linhasComDuasDatas++;
    } else if (datas && datas.length === 1) {
      linhasComUmaData++;
    }

    // Contar linhas que sao APENAS um valor (sem descricao)
    if (/^\d{1,3}(?:\.\d{3})*,\d{2}$/.test(trimmed)) {
      linhasSoValor++;
    }
  }

  const totalLinhasComData = linhasComDuasDatas + linhasComUmaData;

  return {
    columnar: linhasComDuasDatas >= 2 || linhasSoValor >= 5,
    linhasComDuasDatas,
    linhasComUmaData,
    linhasSoValor,
    percentualDuasDatas: totalLinhasComData > 0
      ? Math.round((linhasComDuasDatas / totalLinhasComData) * 100)
      : 0
  };
}

// ===== PIPELINE DE EXTRACAO (METADADOS ONLY) =====

/**
 * Extrai metadados do texto do PDF Santander.
 *
 * Santander tem layout columnar onde pdf-parse separa datas/descricoes
 * dos valores, tornando regex deterministico impossivel para transacoes.
 * Retorna ZERO transacoes + needsAI=true para forcar IA visual,
 * junto com metadados ricos para o prompt da IA.
 */
export function extractPipeline(texto) {
  // Detectar layout columnar — para logging e metadados
  const deteccaoColumnar = detectarLayoutColumnar(texto);
  console.log(`[Santander Pipeline] Deteccao layout columnar: ${JSON.stringify(deteccaoColumnar)}`);

  // Extrair metadados confiaveis
  const totalFaturaPDF = extrairTotalFaturaPDF(texto);
  const cartoesDetectados = extrairCartoes(texto);
  const resumoFatura = extrairResumoFatura(texto);
  const anuidadeTotal = extrairAnuidade(texto);

  console.log(`[Santander Pipeline] Total fatura PDF: ${totalFaturaPDF}`);
  console.log(`[Santander Pipeline] Cartoes: ${JSON.stringify(cartoesDetectados)}`);
  console.log(`[Santander Pipeline] Resumo fatura: ${JSON.stringify(resumoFatura)}`);
  console.log(`[Santander Pipeline] Anuidade total: ${anuidadeTotal}`);

  // Santander SEMPRE tem layout columnar — forcar IA visual
  console.log('[Santander Pipeline] SEMPRE needsAI=true: Santander usa layout columnar — forcando IA visual');

  // Auditoria com zeros (sem transacoes deterministicas)
  const auditoria = calcularAuditoria([], totalFaturaPDF);

  return {
    success: true,
    transacoes: [],
    total_encontrado: 0,
    valor_total: 0,
    banco_detectado: 'Santander',
    metodo: 'PARSER_DETERMINISTICO',
    auditoria: {
      ...auditoria,
      total_fatura_pdf: totalFaturaPDF,
      equacao: 'Pipeline Santander: metadados-only, transacoes via IA visual'
    },
    needsAI: true,
    metadados_verificacao: {
      total_fatura_pdf: totalFaturaPDF,
      resumo_fatura_pdf: resumoFatura,
      anuidade_pdf: anuidadeTotal,
      cartoes: cartoesDetectados,
      layout_columnar: deteccaoColumnar
    }
  };
}

// ===== PROMPT PARA IA VISUAL =====

/**
 * Constroi prompt especifico para Santander.
 * Santander tem layout columnar — pdf-parse corrompe valores.
 * IA visual e obrigatoria para extracao correta das transacoes.
 *
 * Bugs conhecidos que o prompt previne:
 * 1. "Seu Limite e:" R$10.570 nao e transacao (e limite do cartao)
 * 2. "PAGAMENTO DE FATURA-INTERNET" nao e transacao (e pagamento anterior)
 * 3. Valores corrompidos pelo layout columnar (IA visual le correto)
 */
export function buildAIPrompt(cartaoNome, tipoCartao, metadados) {
  const totalFatura = metadados?.total_fatura_pdf
    ? `R$ ${metadados.total_fatura_pdf.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
    : null;

  const anuidadeInfo = metadados?.anuidade_pdf
    ? `R$ ${metadados.anuidade_pdf.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
    : null;

  const cartoesInfo = metadados?.cartoes?.length > 0
    ? metadados.cartoes.map(c => `final ${c}`).join(', ')
    : null;

  const resumoInfo = metadados?.resumo_fatura_pdf;

  let metadadosBloco = '\n<metadata>\nMetadados extraidos automaticamente do PDF para verificacao cruzada:';
  if (totalFatura) metadadosBloco += `\n- Total da fatura (Total a Pagar): ${totalFatura}`;
  if (anuidadeInfo) metadadosBloco += `\n- Anuidade total: ${anuidadeInfo}`;
  if (cartoesInfo) metadadosBloco += `\n- Cartoes na fatura: ${cartoesInfo}`;
  if (resumoInfo) {
    metadadosBloco += '\n- Resumo da Fatura (pagina final):';
    if (resumoInfo.saldo_anterior) metadadosBloco += `\n  Saldo Anterior: R$ ${resumoInfo.saldo_anterior.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
    if (resumoInfo.total_despesas_brasil) metadadosBloco += `\n  Total Despesas Brasil: R$ ${resumoInfo.total_despesas_brasil.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
    if (resumoInfo.total_pagamentos) metadadosBloco += `\n  Total Pagamentos: R$ ${resumoInfo.total_pagamentos.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
  }
  metadadosBloco += '\n</metadata>';

  return `Voce e um especialista em extrair transacoes de faturas de cartao de credito Santander.
Analise visualmente este PDF de fatura do cartao "${cartaoNome}"${tipoCartao ? ` (cartao ${tipoCartao})` : ''}.

<context>
Este PDF Santander usa layout columnar: datas e descricoes ficam em um bloco e valores em outro bloco separado. O texto extraido automaticamente por OCR fica corrompido — por isso voce deve ler visualmente as tabelas do PDF para obter valores corretos.
${metadadosBloco}
</context>

<pdf_structure>
Estrutura tipica de uma fatura Santander:

- Pagina 1: Resumo da fatura (Total a Pagar, Pagamento Minimo, limite de credito, historico, anuidade). Esta pagina nao contem transacoes de compra.
- Paginas 2-3: "Detalhamento da Fatura" com transacoes organizadas por cartao. Cada cartao aparece em um bloco com nome e ultimos 4 digitos (ex: "NOME - 4258 XXXX XXXX 8172"). Dentro de cada cartao ha secoes: "Despesas", "Parcelamentos", "Pagamento e Demais Creditos".
- "Resumo da Fatura" no final: contem apenas totais para conferencia, nao transacoes individuais.
</pdf_structure>

<extraction_rules>
1. Extraia transacoes apenas da secao "Detalhamento da Fatura" (paginas 2-3).
2. Inclua transacoes de todos os cartoes presentes (${cartoesInfo || 'multiplos cartoes'}).
3. Cada transacao tem: Data (DD/MM) | Descricao | Valor em R$.
4. Leia os valores visualmente da coluna "R$", porque o texto extraido automaticamente pode estar corrompido.
</extraction_rules>

<items_to_exclude>
Nao inclua no JSON os seguintes itens. Cada um tem uma razao especifica:

- Toda a pagina 1 (resumo, opcoes de pagamento, historico, limites de credito) — sao informacoes de resumo, nao transacoes.
- "Seu Limite e:" e qualquer valor de limite — e o limite do cartao, nao uma despesa.
- "Pagamento Total" e "Pagamento Minimo" da pagina 1 — sao opcoes de pagamento da fatura, nao compras.
- "PAGAMENTO DE FATURA-INTERNET" e toda secao "Pagamento e Demais Creditos" — sao pagamentos da fatura anterior. Incluir esses itens causaria erro na reconciliacao.
- "Historico de Faturas" e valores de meses anteriores (NOV, DEZ, JAN, FEV) — referem-se a faturas passadas.
- "Resumo da Fatura" — e um bloco de conferencia com totais agregados.
- Linhas de "VALOR TOTAL" — sao subtotais de secao, nao transacoes individuais.
- Informacoes de Smiles/milhas, juros, CET, parcelamento de fatura, credito rotativo — sao informacoes financeiras, nao despesas.
- Endereco do titular, codigo de barras, dados de correspondencia.
</items_to_exclude>

<classification>
Cada transacao deve ter um campo tipo_lancamento. Classifique assim:

- "compra": compras normais (FACEBK, PAYPAL, MERCADOLIVRE, UBER, TIGELA ACAI, restaurantes, lojas, etc.)
- "tarifa_cartao": "ANUIDADE DIFERENCIADA", "SEG CONTA CART" (seguro do cartao), "AJ A DEB TARIFA"
- "iof": "IOF" (Imposto sobre Operacoes Financeiras)
- "estorno": estornos, creditos, devolucoes, reembolsos
- "pagamento_antecipado": pagamento antecipado de parcelas

Valores negativos no PDF indicam estornos ou creditos. Registre-os com tipo_lancamento "estorno" e valor positivo no JSON, porque o sistema de reconciliacao espera valores positivos e subtrai estornos na formula.
</classification>

<installments>
Transacoes da secao "Parcelamentos" sao compras parceladas. Inclua com tipo_lancamento "compra" e preencha o campo parcela com "X/Y" quando disponivel.
Exemplo: "SMILES CLUB SMIL" parcela 02/12 -> parcela: "2/12", tipo_lancamento: "compra".
</installments>

<reconciliation>
Para validar a extracao, confira que a soma:
  compras + iof + tarifa_cartao - estornos - pagamento_antecipado
seja proxima de ${totalFatura || 'o total da fatura no PDF'}.
Se houver divergencia significativa, revise se alguma transacao foi esquecida em outro cartao ou pagina.
</reconciliation>

<output_format>
Retorne somente um JSON valido, sem markdown e sem comentarios:
{
  "transacoes": [
    {
      "data": "DD/MM/YYYY",
      "descricao": "descricao da transacao",
      "valor": 123.45,
      "parcela": "1/3" ou null,
      "tipo_lancamento": "compra"
    }
  ],
  "total_encontrado": numero_total_de_transacoes,
  "valor_total": soma_apenas_das_compras,
  "banco_detectado": "Santander"
}
</output_format>`;
}

// ===== CORRECOES POS-IA =====

/**
 * Aplica correcoes pos-IA nas transacoes retornadas pela IA visual.
 *
 * 1. filtrarTransacoesIA() — remove subtotais, pagamentos, limites
 * 2. corrigirEstornosIA() — detecta estornos mal-classificados como compra
 *
 * @param {Array} transacoes - Transacoes retornadas pela IA
 * @param {Object} metadados - Metadados extraidos pelo extractPipeline
 * @returns {Array} Transacoes corrigidas
 */
export function postAICorrections(transacoes, metadados) {
  // 1. Filtrar transacoes invalidas (subtotais, pagamentos, limites)
  const filtradas = filtrarTransacoesIA(transacoes);

  // 2. Corrigir estornos mal-classificados como compra
  const corrigidas = corrigirEstornosIA(filtradas, metadados?.total_fatura_pdf);

  return corrigidas;
}

// ===== PARSER LEGADO (compatibilidade) =====

/**
 * Parser principal Santander — extrai apenas metadados e forca IA visual.
 *
 * Mantido para compatibilidade com o sistema existente que importa
 * parseSantander de cada modulo de banco. Internamente delega para
 * extractPipeline e adapta o formato de retorno.
 */
export function parseSantander(texto) {
  const resultado = extractPipeline(texto);

  // Adaptar formato de retorno para compatibilidade com o sistema legado
  return {
    transacoes: resultado.transacoes,
    total_encontrado: resultado.total_encontrado,
    valor_total: resultado.valor_total,
    banco_detectado: resultado.banco_detectado,
    confianca_texto: 'baixa',
    cartoes_detectados: resultado.metadados_verificacao.cartoes,
    resumo_fatura: {
      ...resultado.auditoria,
      subtotais_pdf: []
    },
    metadados_verificacao: resultado.metadados_verificacao
  };
}

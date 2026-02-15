/**
 * Pipeline: PicPay (Metadados + IA Visual Obrigatoria)
 *
 * Parser para faturas de cartao de credito PicPay.
 *
 * Problema central: faturas PicPay SEMPRE usam layout de duas colunas no PDF.
 * Quando pdf-parse extrai o texto, as colunas se intercalam, gerando
 * linhas "data descricao valor data descricao valor" que os regexes
 * nao capturam corretamente. Resultado: valores concatenados e transacoes fantasma.
 *
 * Estrategia (metadata-only + IA visual):
 *   1. Extrai metadados confiaveis do texto (total da fatura, subtotais, cartoes)
 *   2. NAO tenta capturar transacoes (impossivel com texto intercalado)
 *   3. SEMPRE retorna needsAI: true para forcar IA visual
 *   4. IA visual recebe metadados para verificacao cruzada
 *   5. IA visual le o PDF renderizado e extrai transacoes corretamente
 *
 * Caracteristicas PicPay:
 * - Layout 2 colunas (um cartao a esquerda, outro a direita) — SEMPRE
 * - Ate 7+ cartoes separados (Picpay Card, final 8036, 8051, 0025, 0033, 0041, 0058)
 * - Transacoes internacionais com conversao USD->BRL
 * - Mastercard BLACK
 * - Valores negativos = estornos/creditos/pagamentos
 * - "PAGAMENTO DE FATURA PELO PICPA" = pagamento da fatura anterior (ignorar)
 * - "IOF COMPRA INTERNACIONAL" = IOF (nao e compra de cambio)
 * - Paginas 9-10: informacoes financeiras (parcelamento/juros) — NAO sao transacoes
 * - "Subtotal dos lancamentos" por cartao
 * - "Total geral dos lancamentos" no final
 * - Programa Smiles (ignorar informacoes de milhas)
 *
 * Interface padrao de pipeline:
 *   extractPipeline(texto, options)  - funcao principal (retorna metadados, zero transacoes)
 *   buildAIPrompt(...)               - prompt especializado para IA visual
 *   postAICorrections(...)           - filtragem + correcao de estornos pos-IA
 */

import { parseValorBR, calcularAuditoria, corrigirEstornosIA } from '../utils.js';

// ===== CONSTANTES =====

export const BANK_ID = 'picpay';

/**
 * Contextos de parcelamento/financiamento que devem ser ignorados
 * ao extrair totais e subtotais.
 */
const CONTEXTOS_PARCELAMENTO = [
  'PARCELA', 'JUROS', 'FINANC', 'CET ', 'A.M.', 'FIXAS',
  'PARCELAMENTO', 'IOF FINANC', 'TAXA DE JUROS',
  'ENCARGOS', 'EM AT', 'VALOR MINIMO', 'SALDO FINANCIADO',
  'CREDITO ROTATIVO'
];

// ===== HELPERS INTERNOS =====

/**
 * Detecta se o texto extraido pelo pdf-parse esta intercalado
 * (layout de duas colunas misturado).
 *
 * Heuristica: conta linhas que contem 2+ padroes de data DD/MM
 * separados por texto/espaco. Se muitas linhas tem isso, o texto
 * esta intercalado.
 */
function detectarTextoIntercalado(texto) {
  const linhas = texto.split('\n');
  let linhasComDuasDatas = 0;
  let linhasComUmaData = 0;

  for (const linha of linhas) {
    const datas = linha.match(/\d{1,2}\/\d{1,2}/g);
    if (datas && datas.length >= 2) {
      linhasComDuasDatas++;
    } else if (datas && datas.length === 1) {
      linhasComUmaData++;
    }
  }

  const totalLinhasComData = linhasComDuasDatas + linhasComUmaData;

  if (totalLinhasComData > 5 && linhasComDuasDatas / totalLinhasComData > 0.25) {
    return {
      intercalado: true,
      linhasComDuasDatas,
      linhasComUmaData,
      percentual: Math.round((linhasComDuasDatas / totalLinhasComData) * 100)
    };
  }

  return {
    intercalado: false,
    linhasComDuasDatas,
    linhasComUmaData,
    percentual: totalLinhasComData > 0
      ? Math.round((linhasComDuasDatas / totalLinhasComData) * 100)
      : 0
  };
}

/**
 * Verifica se uma posicao no texto esta dentro de contexto de
 * parcelamento/financiamento (paginas 9-10 do PDF PicPay).
 *
 * Olha uma vizinhanca de 300 chars antes e 100 chars depois.
 */
function emContextoParcelamento(textoUpper, posicao) {
  const vizinhanca = textoUpper.substring(
    Math.max(0, posicao - 300),
    Math.min(textoUpper.length, posicao + 100)
  );
  return CONTEXTOS_PARCELAMENTO.some(ctx => vizinhanca.includes(ctx));
}

/**
 * Extrai o "Total da fatura" do texto do PDF PicPay.
 *
 * CUIDADO: Faturas PicPay incluem secao de parcelamento/financiamento (pags 9-10)
 * com "Valor total a pagar R$ 124.526,55" que INCLUI juros e IOF de financiamento.
 * O total real e "Total da fatura 109.864,59" na pag. 1.
 *
 * Prioridade:
 *   1. "Total da fatura" (fora contexto parcelamento)
 *   2. "Total geral dos lancamentos" (soma bruta de despesas)
 *   3. "Pagamento total" (fora contexto parcelamento)
 *   4. "Total a pagar" (fora contexto parcelamento)
 */
function extrairTotalFaturaPDF(texto) {
  const textoUpper = texto.toUpperCase();

  // 1a. Padrao prioritario: "Total da fatura" na mesma linha (resumo na pag. 1)
  const regexTotal = /TOTAL\s+DA\s+FATURA\s*:?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;
  let match;
  while ((match = regexTotal.exec(texto)) !== null) {
    if (!emContextoParcelamento(textoUpper, match.index)) {
      const valor = parseValorBR(match[1]);
      if (valor > 0) {
        console.log(`[PicPay Pipeline] Total extraido via "total da fatura" (mesma linha): ${valor}`);
        return valor;
      }
    }
  }

  // 1b. Fallback: "Total da fatura" na linha N, valor na linha N+1
  // PicPay separa label e valor em linhas distintas no pdf-parse:
  //   L19: "Total da fatura"
  //   L20: "109.864,59"
  const linhas = texto.split('\n');
  for (let i = 0; i < linhas.length - 1; i++) {
    if (/TOTAL\s+DA\s+FATURA/i.test(linhas[i].trim()) &&
        !emContextoParcelamento(textoUpper, texto.indexOf(linhas[i]))) {
      const proximaLinha = linhas[i + 1].trim();
      // Valor pode vir com ou sem R$, sozinho na linha
      const matchValor = proximaLinha.match(/^R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})$/);
      if (matchValor) {
        const valor = parseValorBR(matchValor[1]);
        if (valor > 0) {
          console.log(`[PicPay Pipeline] Total extraido via "total da fatura" + proxima linha: ${valor}`);
          return valor;
        }
      }
    }
  }

  // 2. "Total geral dos lancamentos" (soma bruta das despesas)
  const regexTotalGeral = /TOTAL\s+GERAL\s+DOS\s+LAN[CÇ]AMENTOS\s*:?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;
  match = regexTotalGeral.exec(texto);
  if (match) {
    const valor = parseValorBR(match[1]);
    if (valor > 0) {
      console.log(`[PicPay Pipeline] Total extraido via "total geral dos lancamentos": ${valor}`);
      return valor;
    }
  }

  // 3a. "Pagamento total" na mesma linha, fora de contexto de parcelamento
  const regexPagTotal = /PAGAMENTO\s+TOTAL\s*:?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;
  while ((match = regexPagTotal.exec(texto)) !== null) {
    if (!emContextoParcelamento(textoUpper, match.index)) {
      const valor = parseValorBR(match[1]);
      if (valor > 0) {
        console.log(`[PicPay Pipeline] Total extraido via "pagamento total" (mesma linha): ${valor}`);
        return valor;
      }
    }
  }

  // 3b. "Pagamento total" na linha N, valor na linha N+1
  // Mesmo problema de split-line do "Total da fatura":
  //   L23: "Pagamento total"
  //   L24: "109.864,59"
  for (let i = 0; i < linhas.length - 1; i++) {
    if (/PAGAMENTO\s+TOTAL/i.test(linhas[i].trim()) &&
        !emContextoParcelamento(textoUpper, texto.indexOf(linhas[i]))) {
      const proximaLinha = linhas[i + 1].trim();
      const matchValor = proximaLinha.match(/^R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})$/);
      if (matchValor) {
        const valor = parseValorBR(matchValor[1]);
        if (valor > 0) {
          console.log(`[PicPay Pipeline] Total extraido via "pagamento total" + proxima linha: ${valor}`);
          return valor;
        }
      }
    }
  }

  // 4a. Generico: "Total a pagar" na mesma linha, fora de contexto
  const regexTotalPagar = /TOTAL\s+(?:A\s+)?PAGAR\s*:?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;
  while ((match = regexTotalPagar.exec(texto)) !== null) {
    if (!emContextoParcelamento(textoUpper, match.index)) {
      const valor = parseValorBR(match[1]);
      if (valor > 0) {
        console.log(`[PicPay Pipeline] Total extraido via "total a pagar" (mesma linha): ${valor}`);
        return valor;
      }
    }
  }

  // 4b. "Total a pagar" na linha N, valor na linha N+1
  for (let i = 0; i < linhas.length - 1; i++) {
    if (/TOTAL\s+(?:A\s+)?PAGAR/i.test(linhas[i].trim()) &&
        !emContextoParcelamento(textoUpper, texto.indexOf(linhas[i]))) {
      const proximaLinha = linhas[i + 1].trim();
      const matchValor = proximaLinha.match(/^R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})$/);
      if (matchValor) {
        const valor = parseValorBR(matchValor[1]);
        if (valor > 0) {
          console.log(`[PicPay Pipeline] Total extraido via "total a pagar" + proxima linha: ${valor}`);
          return valor;
        }
      }
    }
  }

  console.log('[PicPay Pipeline] Nenhum total da fatura encontrado fora de contexto de parcelamento');
  return null;
}

/**
 * Extrai subtotais por secao/cartao do texto PicPay.
 * Util como metadado de verificacao para a IA.
 *
 * Padroes:
 *   "Subtotal dos lancamentos 36.076,65"
 *   "Total geral dos lancamentos 118.485,09"
 */
function extrairSubtotais(texto) {
  const subtotais = [];
  const textoUpper = texto.toUpperCase();

  // Subtotais por cartao (LANCAMENTOS ou LANÇAMENTOS — pdf-parse pode manter acentos)
  const regexSubtotal = /SUBTOTAL\s+DOS\s+LAN[CÇ]AMENTOS\s*:?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;
  let match;
  while ((match = regexSubtotal.exec(texto)) !== null) {
    if (emContextoParcelamento(textoUpper, match.index)) {
      console.log(`[PicPay Pipeline] Subtotal ignorado (contexto parcelamento): ${match[0].trim()}`);
      continue;
    }
    const valor = parseValorBR(match[1]);
    if (valor > 0) {
      subtotais.push({ descricao: 'Subtotal cartao', valor });
    }
  }

  // Total geral
  const regexTotalGeral = /TOTAL\s+GERAL\s+DOS\s+LAN[CÇ]AMENTOS\s*:?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;
  match = regexTotalGeral.exec(texto);
  if (match) {
    const valor = parseValorBR(match[1]);
    if (valor > 0) {
      subtotais.push({ descricao: 'Total geral lancamentos', valor });
    }
  }

  return subtotais;
}

/**
 * Extrai numeros de cartao (finais) mencionados no PDF.
 * Ex: "Picpay Card final 8036", "final 0025"
 * Tambem detecta "PICPAY CARD" sem final como 'PRINCIPAL'.
 */
function extrairCartoes(texto) {
  const cartoes = new Set();

  // Padrao "FINAL NNNN"
  const regexFinal = /(?:CART[ÃA]O\s+)?FINAL\s+(\d{4})/gi;
  let match;
  while ((match = regexFinal.exec(texto)) !== null) {
    cartoes.add(match[1]);
  }

  // Detectar "Picpay Card" (cartao principal, sem final)
  if (/PICPAY\s+CARD(?!\s+FINAL)/i.test(texto)) {
    cartoes.add('PRINCIPAL');
  }

  return [...cartoes];
}

/**
 * Extrai o valor de "Despesas do mes" do resumo PicPay.
 * Util para verificacao cruzada: despesas_do_mes ~= total_compras + iof + tarifa
 */
function extrairDespesasDoMes(texto) {
  const regex = /DESPESAS\s+DO\s+M[EÊ]S\s*:?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;
  const match = regex.exec(texto);
  if (match) {
    return parseValorBR(match[1]);
  }
  return null;
}

/**
 * Extrai o valor de "Creditos e estornos" do resumo PicPay.
 */
function extrairCreditosEstornos(texto) {
  const regex = /CR[EÉ]DITOS\s+E\s+ESTORNOS\s*:?\s*-?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;
  const match = regex.exec(texto);
  if (match) {
    return parseValorBR(match[1]);
  }
  return null;
}

// ===== PIPELINE PRINCIPAL =====

/**
 * Extrai metadados de uma fatura PicPay.
 *
 * PicPay SEMPRE usa layout 2 colunas, entao o parser deterministico
 * NUNCA conseguira extrair transacoes corretamente via regex.
 * Retorna ZERO transacoes + needsAI: true para SEMPRE forcar IA visual,
 * junto com metadados ricos para o prompt da IA.
 *
 * @param {string} texto - Texto completo extraido do PDF
 * @param {object} [options={}] - Opcoes (nao usadas atualmente)
 * @returns {object} PipelineResult padrao com needsAI: true
 */
export function extractPipeline(texto, options = {}) {
  // Detectar texto intercalado (duas colunas) — para logging
  const deteccaoIntercalado = detectarTextoIntercalado(texto);
  console.log(`[PicPay Pipeline] Deteccao de intercalacao: ${JSON.stringify(deteccaoIntercalado)}`);

  // Extrair metadados confiaveis (funcionam mesmo com texto intercalado)
  const totalFaturaPDF = extrairTotalFaturaPDF(texto);
  const subtotais = extrairSubtotais(texto);
  const cartoesDetectados = extrairCartoes(texto);
  const despesasDoMes = extrairDespesasDoMes(texto);
  const creditosEstornos = extrairCreditosEstornos(texto);

  console.log(`[PicPay Pipeline] Total fatura PDF: ${totalFaturaPDF}`);
  console.log(`[PicPay Pipeline] Despesas do mes: ${despesasDoMes}`);
  console.log(`[PicPay Pipeline] Creditos e estornos: ${creditosEstornos}`);
  console.log(`[PicPay Pipeline] Subtotais: ${JSON.stringify(subtotais)}`);
  console.log(`[PicPay Pipeline] Cartoes: ${JSON.stringify(cartoesDetectados)}`);

  // PicPay SEMPRE tem layout 2 colunas — forcar IA visual
  console.log('[PicPay Pipeline] Confianca SEMPRE BAIXA: PicPay usa layout 2 colunas — forcando IA visual');

  // Auditoria com zero transacoes + metadados do PDF
  const auditoria = calcularAuditoria([], totalFaturaPDF);
  auditoria.despesas_do_mes_pdf = despesasDoMes;
  auditoria.creditos_estornos_pdf = creditosEstornos;

  return {
    success: true,
    transacoes: [],
    total_encontrado: 0,
    valor_total: 0,
    banco_detectado: 'PicPay',
    metodo: 'PARSER_DETERMINISTICO',
    auditoria,
    needsAI: true,
    metadados_verificacao: {
      total_fatura_pdf: totalFaturaPDF,
      despesas_do_mes_pdf: despesasDoMes,
      creditos_estornos_pdf: creditosEstornos,
      subtotais,
      cartoes: cartoesDetectados,
      intercalacao: deteccaoIntercalado
    }
  };
}

// ===== INTERFACE IA =====

/**
 * Constroi prompt especializado para IA visual analisar fatura PicPay.
 *
 * O prompt explica o layout de duas colunas, inclui metadados para
 * verificacao cruzada, e instrui a IA a extrair transacoes de todos
 * os cartoes em todas as paginas.
 *
 * @param {string} cartaoNome - Nome do cartao (ex: "PicPay Mastercard")
 * @param {string} tipoCartao - Tipo (ex: "credito")
 * @param {object} metadados - Metadados extraidos pelo parser (metadados_verificacao)
 * @returns {string} Prompt completo para a IA visual
 */
export function buildAIPrompt(cartaoNome, tipoCartao, metadados) {
  const totalFatura = metadados?.total_fatura_pdf
    ? `R$ ${metadados.total_fatura_pdf.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
    : null;

  const despesasMes = metadados?.despesas_do_mes_pdf
    ? `R$ ${metadados.despesas_do_mes_pdf.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
    : null;

  const creditosEstornos = metadados?.creditos_estornos_pdf
    ? `R$ ${metadados.creditos_estornos_pdf.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
    : null;

  const subtotaisInfo = metadados?.subtotais?.length > 0
    ? metadados.subtotais.map(s => `  - ${s.descricao}: R$ ${s.valor.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`).join('\n')
    : null;

  const cartoesInfo = metadados?.cartoes?.length > 0
    ? metadados.cartoes.map(c => c === 'PRINCIPAL' ? 'Picpay Card (principal)' : `Picpay Card final ${c}`).join(', ')
    : null;

  let metadadosBloco = '\n<metadata>\nMetadados extraidos automaticamente do PDF para verificacao cruzada:';
  if (totalFatura) metadadosBloco += `\n- Total da fatura: ${totalFatura}`;
  if (despesasMes) metadadosBloco += `\n- Despesas do mes (bruto): ${despesasMes}`;
  if (creditosEstornos) metadadosBloco += `\n- Creditos e estornos: ${creditosEstornos}`;
  if (cartoesInfo) metadadosBloco += `\n- Cartoes na fatura: ${cartoesInfo}`;
  if (subtotaisInfo) metadadosBloco += `\n- Subtotais por cartao:\n${subtotaisInfo}`;
  metadadosBloco += '\n</metadata>';

  return `Voce e um especialista em extrair transacoes de faturas de cartao de credito PicPay.
Analise visualmente este PDF de fatura do cartao "${cartaoNome}"${tipoCartao ? ` (cartao ${tipoCartao})` : ''}.

IMPORTANTE: Sua resposta DEVE ser EXCLUSIVAMENTE um JSON valido. Nao inclua texto antes ou depois do JSON, nao use markdown (\`\`\`), nao adicione comentarios. Apenas o objeto JSON puro.

<context>
Este PDF PicPay usa layout de duas colunas lado a lado: um cartao aparece na coluna esquerda e outro na coluna direita. O texto extraido automaticamente intercala as duas colunas, tornando regex impossivel. Por isso voce deve ler visualmente ambas as colunas de todas as paginas.

A fatura contem aproximadamente 200+ transacoes distribuidas em 7-8 paginas, com ${cartoesInfo ? metadados.cartoes.length : 'varios'} cartoes.
${metadadosBloco}
</context>

<extraction_rules>
1. Extraia TODAS as transacoes de TODOS os cartoes presentes no PDF (${cartoesInfo || 'varios cartoes'}).
2. Percorra as paginas de 1 a 8 SEQUENCIALMENTE. As paginas 9-10 contem informacoes financeiras (parcelamento, juros, CET) e devem ser ignoradas.
3. Para CADA pagina, leia AMBAS as colunas (esquerda e direita) — pular uma coluna causa perda de metade das transacoes.
4. Cada cartao tem secoes "Transacoes Nacionais" e possivelmente "Transacoes Internacionais".
5. Se uma pagina for dificil de ler, extraia o maximo possivel e continue com as proximas paginas. E melhor retornar transacoes parciais do que retornar zero transacoes.
6. A fatura tipicamente contem entre 150 e 250 transacoes. Se voce extraiu menos de 50, provavelmente pulou paginas ou colunas — revise.
</extraction_rules>

<international_transactions>
Transacoes internacionais mostram tanto o valor em USD quanto o valor convertido em BRL. Use o valor em BRL (ja convertido), porque e o valor efetivamente cobrado na fatura.

Exemplos:
- "Dolar: 72,32 | Cambio do dia: R$ 5,7918 | 72,32  418,86" -> use 418,86 (BRL)
- "USD 72,32 BRL 418,86" -> use 418,86
</international_transactions>

<classification>
Cada transacao deve ter um campo tipo_lancamento. Classifique assim:

- "compra": compras nacionais e internacionais (incluindo parceladas)
- "iof": IOF (Imposto sobre Operacoes Financeiras), incluindo "IOF COMPRA INTERNACIONAL"
- "estorno": estornos, creditos na fatura, devolucoes, reembolsos, cashback, ESTORNO DE ANUIDADE, ESTORNO DE ANUIDADE DIF
- "pagamento_antecipado": pagamento antecipado, pagamento parcial
- "tarifa_cartao": anuidade, tarifa do cartao, seguro fatura, "AJ A DEB TARIFA"

Valores negativos no PDF indicam estornos ou creditos. Registre-os com tipo_lancamento "estorno" e valor POSITIVO no JSON, porque o sistema de reconciliacao espera valores positivos e subtrai estornos na formula.
</classification>

<items_to_exclude>
Nao inclua no JSON os seguintes itens. Cada um tem uma razao especifica:

- "PAGAMENTO DE FATURA PELO PICPA" ou qualquer variacao — e o pagamento da fatura anterior. Incluir causaria erro na reconciliacao.
- "Pagamento recebido", "Pagamento efetuado" — mesma razao acima.
- Linhas de "Subtotal dos lancamentos", "Total geral dos lancamentos" — sao agregacoes, nao transacoes individuais.
- Cabecalhos de secoes e titulos de cartoes — sao apenas titulos organizacionais.
- Informacoes de milhas Smiles (ex: "12345 milhas") — nao representam despesas.
- Informacoes financeiras das paginas 9-10 (parcelamento, juros, CET, IOF financiamento) — referem-se a simulacoes de parcelamento da fatura, nao a compras realizadas.
</items_to_exclude>

<formatting>
- Data: DD/MM/YYYY (adicione o ano baseado no vencimento da fatura)
- Valor: numero positivo com 2 casas decimais (ex: 1234.56, sem formatacao brasileira)
- Parcela: "1/3" se parcelada, null se nao
</formatting>

<reconciliation>
Para validar a extracao, confira que a soma:
  compras + iof + tarifa_cartao - estornos - pagamento_antecipado
seja proxima de ${totalFatura || 'o total da fatura no PDF'}.
Se houver divergencia significativa, revise se alguma coluna ou pagina foi pulada.
</reconciliation>

<output_format>
Retorne SOMENTE um JSON valido, sem markdown, sem comentarios, sem texto adicional:
{
  "transacoes": [
    {
      "data": "DD/MM/YYYY",
      "descricao": "descricao da transacao",
      "valor": 123.45,
      "parcela": "1/3",
      "tipo_lancamento": "compra"
    }
  ],
  "total_encontrado": numero_total_de_transacoes,
  "valor_total": soma_apenas_das_compras,
  "banco_detectado": "PicPay"
}
</output_format>`;
}

/**
 * Aplica correcoes pos-IA nas transacoes extraidas pela IA visual.
 *
 * 1. Filtra transacoes invalidas (subtotais, pagamentos de fatura, etc.)
 * 2. Corrige estornos mal-classificados como "compra" pela IA
 *
 * @param {Array} transacoes - Transacoes retornadas pela IA
 * @param {object} metadados - Metadados extraidos pelo parser (metadados_verificacao)
 * @returns {Array} Transacoes corrigidas
 */
export function postAICorrections(transacoes, metadados) {
  // NOTA: filtrarTransacoesIA() já é chamado em route.js (linha 268) antes de postAICorrections.
  // Remover chamada duplicada aqui para evitar dupla filtragem.

  // Corrigir estornos mal-classificados
  const corrigidas = corrigirEstornosIA(transacoes, metadados?.total_fatura_pdf);

  return corrigidas;
}

// ===== BACKWARD COMPAT =====

/**
 * Funcao legada para compatibilidade com codigo existente.
 * Delega para extractPipeline e retorna no formato antigo
 * (com confianca_texto em vez de needsAI).
 */
export function parsePicPay(texto) {
  const resultado = extractPipeline(texto);
  return {
    transacoes: resultado.transacoes,
    total_encontrado: resultado.total_encontrado,
    valor_total: resultado.valor_total,
    banco_detectado: resultado.banco_detectado,
    confianca_texto: 'baixa',
    cartoes_detectados: resultado.metadados_verificacao.cartoes,
    resumo_fatura: {
      total_compras: 0,
      iof: 0,
      estornos: 0,
      pagamento_antecipado: 0,
      tarifa_cartao: 0,
      total_fatura_pdf: resultado.metadados_verificacao.total_fatura_pdf,
      total_fatura_calculado: 0,
      despesas_do_mes_pdf: resultado.metadados_verificacao.despesas_do_mes_pdf,
      creditos_estornos_pdf: resultado.metadados_verificacao.creditos_estornos_pdf,
      reconciliado: false,
      diferenca_centavos: null,
      equacao: 'Parser PicPay pipeline: metadados-only, transacoes via IA visual',
      subtotais_pdf: resultado.metadados_verificacao.subtotais
    },
    metadados_verificacao: resultado.metadados_verificacao
  };
}

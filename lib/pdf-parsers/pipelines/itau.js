/**
 * Pipeline de Fatura Itau - Modulo self-contained
 *
 * Problema central: faturas Itau usam layout de duas colunas no PDF.
 * Quando pdf-parse extrai o texto, as colunas se intercalam, gerando
 * linhas "data descricao valor data descricao valor" que os regexes
 * nao capturam corretamente. Resultado: ~40% das transacoes sao perdidas.
 *
 * Estrategia hibrida:
 *   1. Extrai metadados confiaveis do texto (total da fatura, subtotais, IOF)
 *   2. Tenta capturar transacoes com multiplos padroes
 *   3. Detecta se o texto esta intercalado (duas colunas)
 *   4. Se poucas transacoes foram capturadas E texto intercalado detectado,
 *      sinaliza needsAI=true para que o pipeline use IA visual
 *   5. Retorna auditoria com reconciliacao
 *
 * Caracteristicas do Itau:
 * - Layout 2 colunas (cartao titular a esquerda, adicional a direita)
 * - Secoes: "compras e saques", "transacoes internacionais", "outros lancamentos"
 * - Multiplos cartoes: final XXXX para cada titular
 * - IOF aparece como linha separada ou dentro de "outros lancamentos"
 * - Subtotais por secao: "subtotal R$ X.XXX,XX"
 * - Total da fatura: "total da fatura R$ XX.XXX,XX" ou "total a pagar"
 * - Datas no formato DD/MM (sem ano)
 * - Valores no formato brasileiro: 1.234,56
 */

import {
  parseValorBR,
  parseDataBR,
  extrairParcela,
  calcularAuditoria,
  filtrarTransacoesIA,
  corrigirEstornosIA
} from '../utils.js';

// ===== CONSTANTES =====

export const BANK_ID = 'itau';

// Keywords para classificacao de tipo_lancamento
const keywordsPagamentoAntecipado = [
  'PAGAMENTO ANTECIPADO',
  'PGTO ANTECIPADO',
  'PAG ANTECIPADO',
  'PAGAMENTO PARCIAL'
];

const keywordsEstorno = [
  'ESTORNO',
  'CREDITO NA FATURA',
  'CREDITO FATURA',
  'DEVOLUCAO',
  'REEMBOLSO',
  'CASHBACK',
  'BONIFICACAO',
  'CREDITO PROMOCIONAL'
];

const keywordsTarifaCartao = [
  'ANUIDADE',
  'TARIFA CARTAO',
  'TARIFA DO CARTAO',
  'TARIFA MENSAL',
  'SEGURO FATURA',
  'FATURA SEGURA',
  'AVAL EMERG',
  'AVALIACAO EMERG'
];

// Termos a ignorar completamente (nao geram transacao)
const ignorar = [
  'PAGAMENTO FATURA',
  'PAGAMENTO RECEBIDO',
  'PAGAMENTO EFETUADO',
  'DEBITO AUTOMATICO',
  'SALDO ANTERIOR',
  'LIMITE DISPONIVEL',
  'LIMITE TOTAL',
  'TOTAL DA FATURA',
  'TOTAL A PAGAR',
  'SUBTOTAL',
  'VALOR TOTAL'
];

// ===== FUNCOES AUXILIARES =====

/**
 * Classifica uma descricao de transacao em tipo_lancamento.
 * Ordem: pagamento_antecipado -> estorno -> iof -> tarifa_cartao -> ignorar(null) -> compra
 */
function classificarTipoLancamento(descUpper) {
  if (keywordsPagamentoAntecipado.some(kw => descUpper.includes(kw))) {
    return 'pagamento_antecipado';
  }
  if (keywordsEstorno.some(kw => descUpper.includes(kw))) {
    return 'estorno';
  }
  if (descUpper.includes('IOF') || descUpper.includes('IMPOSTO OPERACOES FINANCEIRAS')) {
    return 'iof';
  }
  if (keywordsTarifaCartao.some(kw => descUpper.includes(kw))) {
    return 'tarifa_cartao';
  }
  if (ignorar.some(termo => descUpper.includes(termo))) {
    return null; // ignorar
  }
  return 'compra';
}

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
    // Conta quantos padroes DD/MM aparecem na mesma linha
    const datas = linha.match(/\d{1,2}\/\d{1,2}/g);
    if (datas && datas.length >= 2) {
      linhasComDuasDatas++;
    } else if (datas && datas.length === 1) {
      linhasComUmaData++;
    }
  }

  const totalLinhasComData = linhasComDuasDatas + linhasComUmaData;

  // Se mais de 30% das linhas com data tem duas datas, o texto esta intercalado
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
 * Extrai o "Total da fatura" do texto do PDF Itau.
 *
 * CUIDADO: Faturas Itau incluem secao de "Parcelas fixas" com simulacao
 * de parcelamento (ex: 10x com juros). O "Total a pagar" dessa secao
 * e MAIOR que o total real da fatura (inclui juros, IOF financiamento).
 * Por isso, NAO podemos simplesmente pegar o maior valor.
 *
 * Estrategia:
 *   1. Buscar "total desta fatura" (padrao mais especifico do Itau)
 *   2. Buscar "total da sua fatura e" (padrao frase Itau)
 *   3. Padroes genericos, filtrando contexto de parcelamento
 *   4. Retornar o PRIMEIRO match valido (nao o maior)
 */
function extrairTotalFaturaPDF(texto) {
  const textoUpper = texto.toUpperCase();

  // Contextos que indicam secao de parcelamento/financiamento (NAO sao o total real)
  const contextosParcelamento = [
    'PARCELA', 'JUROS', 'FINANC', 'CET ', 'A.M.', 'FIXAS',
    'CREDICARD', 'PARCELAMENTO', 'IOF FINANC', 'TAXA DE JUROS',
    'ENCARGOS', 'EM AT'
  ];

  /**
   * Verifica se a posicao do match esta dentro de um contexto de parcelamento.
   * Olha 300 caracteres antes e 100 depois do match.
   */
  function emContextoParcelamento(posicao) {
    const vizinhanca = textoUpper.substring(
      Math.max(0, posicao - 300),
      Math.min(textoUpper.length, posicao + 100)
    );
    return contextosParcelamento.some(ctx => vizinhanca.includes(ctx));
  }

  // 1. Padrao prioritario: "total desta fatura" (mais especifico do Itau)
  const regexEspecifico = /TOTAL\s+DESTA\s+FATURA\s*[:\s]*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;
  let match = regexEspecifico.exec(texto);
  if (match) {
    const valor = parseValorBR(match[1]);
    if (valor > 0) {
      console.log(`[Itau Pipeline] Total extraido via "total desta fatura": ${valor}`);
      return valor;
    }
  }

  // 2. Padrao Itau: "O total da sua fatura e R$ XX.XXX,XX"
  const regexFrase = /(?:total\s+da\s+sua\s+fatura\s+[eé]\s*)R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;
  match = regexFrase.exec(texto);
  if (match) {
    const valor = parseValorBR(match[1]);
    if (valor > 0) {
      console.log(`[Itau Pipeline] Total extraido via "total da sua fatura e": ${valor}`);
      return valor;
    }
  }

  // 3. Padroes genericos, filtrando contexto de parcelamento
  const regexGenerico = [
    /TOTAL\s+DA\s+FATURA\s*:?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi,
    /TOTAL\s+(?:A\s+)?PAGAR\s*:?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi,
    /VALOR\s+TOTAL\s+(?:DESTA\s+)?FATURA\s*:?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi,
  ];

  for (const regex of regexGenerico) {
    let m;
    while ((m = regex.exec(texto)) !== null) {
      if (!emContextoParcelamento(m.index)) {
        const valor = parseValorBR(m[1]);
        if (valor > 0) {
          console.log(`[Itau Pipeline] Total extraido via padrao generico (fora de parcelamento): ${valor}`);
          return valor;
        }
      }
    }
  }

  // 4. Nenhum match confiavel encontrado
  console.log('[Itau Pipeline] Nenhum total da fatura encontrado fora de contexto de parcelamento');
  return null;
}

/**
 * Extrai subtotais por secao do texto Itau.
 * Util como metadado de verificacao para a IA.
 *
 * Padroes:
 *   "subtotal R$ 21.120,19"
 *   "subtotal compras e saques R$ 21.120,19"
 *   "Total compras nacionais R$ 21.120,19"
 */
function extrairSubtotais(texto) {
  const subtotais = [];
  const textoUpper = texto.toUpperCase();
  const regex = /(?:subtotal|total)\s+(?:de\s+)?(.{0,40}?)\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;

  // Contextos que indicam secao de parcelamento/financiamento (nao sao subtotais reais)
  const contextosParcelamento = [
    'PARCELA', 'JUROS', 'FINANC', 'CET ', 'A.M.', 'FIXAS',
    'CREDICARD', 'PARCELAMENTO', 'IOF FINANC', 'TAXA DE JUROS',
    'ENCARGOS', 'EM AT'
  ];

  function emContextoParcelamento(posicao) {
    const vizinhanca = textoUpper.substring(
      Math.max(0, posicao - 300),
      Math.min(textoUpper.length, posicao + 100)
    );
    return contextosParcelamento.some(ctx => vizinhanca.includes(ctx));
  }

  let match;
  while ((match = regex.exec(texto)) !== null) {
    // Filtrar subtotais de secoes de parcelamento/financiamento
    if (emContextoParcelamento(match.index)) {
      console.log(`[Itau Pipeline] Subtotal ignorado (contexto parcelamento): ${match[0].trim()}`);
      continue;
    }

    const descricao = match[1].trim();
    const valor = parseValorBR(match[2]);
    if (valor > 0) {
      subtotais.push({ descricao, valor });
    }
  }

  return subtotais;
}

/**
 * Extrai numeros de cartao (finais) mencionados no PDF
 * Ex: "cartao final 1643", "FINAL 7770"
 */
function extrairCartoes(texto) {
  const cartoes = new Set();
  const regex = /(?:CART[ÃA]O\s+)?FINAL\s+(\d{4})/gi;
  let match;
  while ((match = regex.exec(texto)) !== null) {
    cartoes.add(match[1]);
  }
  return [...cartoes];
}

// ===== PARSER DETERMINISTICO =====

/**
 * Parser deterministico principal para faturas Itau.
 * Extrai transacoes usando 5 padroes de regex + metadados de verificacao.
 */
export function parseItau(texto) {
  const transacoes = [];

  // Detectar ano da fatura
  let anoReferencia = new Date().getFullYear();
  const matchAno = texto.match(/(?:FATURA|VENCIMENTO|FECHAMENTO).*?(\d{4})/i);
  if (matchAno) {
    anoReferencia = parseInt(matchAno[1]);
  }

  // Set para evitar duplicatas
  const transacoesUnicas = new Set();

  // Detectar texto intercalado
  const deteccaoIntercalado = detectarTextoIntercalado(texto);
  console.log(`[Itau Pipeline] Deteccao de intercalacao: ${JSON.stringify(deteccaoIntercalado)}`);

  // Extrair metadados confiaveis (funcionam mesmo com texto intercalado)
  const totalFaturaPDF = extrairTotalFaturaPDF(texto);
  const subtotais = extrairSubtotais(texto);
  const cartoesDetectados = extrairCartoes(texto);

  console.log(`[Itau Pipeline] Total fatura PDF: ${totalFaturaPDF}`);
  console.log(`[Itau Pipeline] Subtotais: ${JSON.stringify(subtotais)}`);
  console.log(`[Itau Pipeline] Cartoes: ${JSON.stringify(cartoesDetectados)}`);

  /**
   * Tenta adicionar uma transacao a lista.
   */
  function adicionarTransacao(data, descricao, valor, parcela) {
    if (!data || !descricao || valor <= 0) return false;

    const descUpper = descricao.toUpperCase();
    const tipoLancamento = classificarTipoLancamento(descUpper);

    if (tipoLancamento === null) return false;

    const chave = `${data}|${descricao}|${valor.toFixed(2)}`;

    if (!transacoesUnicas.has(chave)) {
      transacoesUnicas.add(chave);
      transacoes.push({ data, descricao, valor, parcela, tipo_lancamento: tipoLancamento });
      return true;
    }
    return false;
  }

  // ===== PADRAO 1: Transacoes nacionais padrao =====
  // DATA | DESCRICAO | VALOR (fim de linha)
  const regexNacional = /(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(.+?)\s+(-?\d{1,3}(?:\.\d{3})*,\d{2})\s*$/gm;
  let match;

  while ((match = regexNacional.exec(texto)) !== null) {
    let valorStr = match[3];
    // Ignora valores negativos (pagamentos, creditos tratados separadamente)
    if (valorStr.startsWith('-')) {
      // Verifica se e estorno - captura como estorno
      const descUpper = match[2].trim().toUpperCase();
      if (keywordsEstorno.some(kw => descUpper.includes(kw))) {
        const data = parseDataBR(match[1], anoReferencia);
        const valor = parseValorBR(valorStr); // Math.abs via parseValorBR
        adicionarTransacao(data, match[2].trim(), valor, null);
      }
      continue;
    }

    const data = parseDataBR(match[1], anoReferencia);
    const descricao = match[2].trim();
    const valor = parseValorBR(valorStr);
    const parcela = extrairParcela(descricao);
    adicionarTransacao(data, descricao, valor, parcela);
  }

  // ===== PADRAO 2: Transacoes internacionais =====
  // DATA | DESCRICAO | USD XX.XX | BRL YYY,YY  (ou variantes com DOLAR/Cotacao)
  const regexInternacional = /(\d{1,2}\/\d{1,2})\s+(.+?)\s+(?:USD|US\$|DOLAR)\s*[\d.,]+\s+(?:BRL|R\$)\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;

  while ((match = regexInternacional.exec(texto)) !== null) {
    const data = parseDataBR(match[1], anoReferencia);
    const descricao = match[2].trim();
    const valorBRL = parseValorBR(match[3]);
    adicionarTransacao(data, descricao, valorBRL, null);
  }

  // ===== PADRAO 3: Transacoes internacionais formato alternativo Itau =====
  // "DD/MM DESCRICAO                    VALOR_ESTRANGEIRO  VALOR_BRL"
  // onde valor BRL e o ultimo numero da linha
  const regexIntAlt = /(\d{1,2}\/\d{1,2})\s+(.+?)\s+(?:[\d.,]+)\s+(\d{1,3}(?:\.\d{3})*,\d{2})\s*$/gm;

  while ((match = regexIntAlt.exec(texto)) !== null) {
    const descricao = match[2].trim();
    // Verifica se parece transacao internacional (contem indicadores)
    const descUpper = descricao.toUpperCase();
    if (descUpper.includes('*') || descUpper.includes('COTACAO') ||
        descUpper.includes('DOLAR') || /[A-Z]{2}\s*\*/.test(descricao)) {
      const data = parseDataBR(match[1], anoReferencia);
      const valorBRL = parseValorBR(match[3]);
      adicionarTransacao(data, descricao, valorBRL, extrairParcela(descricao));
    }
  }

  // ===== PADRAO 4: Secoes especificas do Itau =====
  // "compras e saques", "transacoes internacionais", "outros lancamentos"
  const secoes = [
    { regex: /(?:compras?\s+e\s+saques?|compras?\s+nacion(?:al|ais))([\s\S]*?)(?=(?:transa[çc][õo]es?\s+internacion|outros\s+lan[çc]amentos|produtos?\s+e\s+servi[çc]os|total\s+da\s+fatura|$))/gi, nome: 'compras_e_saques' },
    { regex: /transa[çc][õo]es?\s+internacion(?:al|ais)([\s\S]*?)(?=(?:outros\s+lan[çc]amentos|produtos?\s+e\s+servi[çc]os|total\s+da\s+fatura|compras?\s+e\s+saques?|$))/gi, nome: 'internacionais' },
    { regex: /outros\s+lan[çc]amentos([\s\S]*?)(?=(?:produtos?\s+e\s+servi[çc]os|total\s+da\s+fatura|compras?\s+e\s+saques?|transa[çc][õo]es?\s+internacion|$))/gi, nome: 'outros_lancamentos' },
  ];

  for (const secao of secoes) {
    let secaoMatch;
    while ((secaoMatch = secao.regex.exec(texto)) !== null) {
      const conteudo = secaoMatch[1];

      // Extrai transacoes da secao
      const regexItem = /(\d{1,2}\/\d{1,2})\s+(.+?)\s+R?\$?\s*(-?\d{1,3}(?:\.\d{3})*,\d{2})/g;

      let itemMatch;
      while ((itemMatch = regexItem.exec(conteudo)) !== null) {
        let valorStr = itemMatch[3];
        // Valores negativos = estornos
        if (valorStr.startsWith('-')) {
          const descUpper = itemMatch[2].trim().toUpperCase();
          if (keywordsEstorno.some(kw => descUpper.includes(kw))) {
            const data = parseDataBR(itemMatch[1], anoReferencia);
            const valor = parseValorBR(valorStr);
            adicionarTransacao(data, itemMatch[2].trim(), valor, null);
          }
          continue;
        }

        const data = parseDataBR(itemMatch[1], anoReferencia);
        const descricao = itemMatch[2].trim();
        const valor = parseValorBR(valorStr);
        adicionarTransacao(data, descricao, valor, extrairParcela(descricao));
      }
    }
  }

  // ===== PADRAO 5: Linha a linha generico =====
  // Fallback para capturar transacoes que os padroes acima podem ter perdido
  const linhas = texto.split('\n').map(l => l.trim()).filter(l => l);

  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i];

    const matchData = linha.match(/^(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(.+)/);
    if (matchData) {
      const data = parseDataBR(matchData[1], anoReferencia);
      let resto = matchData[2].trim();

      const matchValor = resto.match(/(-?\d{1,3}(?:\.\d{3})*,\d{2})\s*$/);
      if (matchValor) {
        let valorStr = matchValor[1];
        if (valorStr.startsWith('-')) {
          const descricao = resto.replace(matchValor[0], '').trim();
          const descUpper = descricao.toUpperCase();
          if (keywordsEstorno.some(kw => descUpper.includes(kw))) {
            const valor = parseValorBR(valorStr);
            adicionarTransacao(data, descricao, valor, null);
          }
          continue;
        }

        const valor = parseValorBR(valorStr);
        const descricao = resto.replace(matchValor[0], '').trim();
        adicionarTransacao(data, descricao, valor, extrairParcela(descricao));
      }
    }
  }

  // ===== CALCULAR CONFIANCA E RESULTADO =====

  const totalCompras = transacoes
    .filter(t => t.tipo_lancamento === 'compra')
    .reduce((sum, t) => sum + t.valor, 0);

  const totalFaturaCalculado = (() => {
    const iof = transacoes.filter(t => t.tipo_lancamento === 'iof').reduce((sum, t) => sum + t.valor, 0);
    const estornos = transacoes.filter(t => t.tipo_lancamento === 'estorno').reduce((sum, t) => sum + t.valor, 0);
    const pagAntecipado = transacoes.filter(t => t.tipo_lancamento === 'pagamento_antecipado').reduce((sum, t) => sum + t.valor, 0);
    const tarifaCartao = transacoes.filter(t => t.tipo_lancamento === 'tarifa_cartao').reduce((sum, t) => sum + t.valor, 0);
    return parseFloat((totalCompras + iof + tarifaCartao - estornos - pagAntecipado).toFixed(2));
  })();

  // Determinar confianca do resultado
  let confiancaTexto = 'alta';
  if (deteccaoIntercalado.intercalado) {
    confiancaTexto = 'baixa';
  } else if (totalFaturaPDF && totalFaturaCalculado < totalFaturaPDF * 0.85) {
    // Capturou menos de 85% do total - algo esta faltando
    confiancaTexto = 'baixa';
  }

  const valorTotal = parseFloat(totalCompras.toFixed(2));

  console.log(`[Itau Pipeline] Transacoes capturadas: ${transacoes.length}`);
  console.log(`[Itau Pipeline] Total compras: ${totalCompras.toFixed(2)}`);
  console.log(`[Itau Pipeline] Total fatura calculado: ${totalFaturaCalculado.toFixed(2)}`);
  console.log(`[Itau Pipeline] Total fatura PDF: ${totalFaturaPDF}`);
  console.log(`[Itau Pipeline] Confianca: ${confiancaTexto}`);

  return {
    transacoes,
    total_encontrado: transacoes.length,
    valor_total: valorTotal,
    banco_detectado: 'Itau',
    confianca_texto: confiancaTexto,
    cartoes_detectados: cartoesDetectados,
    resumo_fatura: calcularAuditoria(transacoes, totalFaturaPDF),
    metadados_verificacao: {
      total_fatura_pdf: totalFaturaPDF,
      subtotais,
      cartoes: cartoesDetectados,
      intercalacao: deteccaoIntercalado
    }
  };
}

// ===== PIPELINE PRINCIPAL =====

/**
 * Pipeline de extracao deterministica para Itau.
 * Retorna resultado padronizado com flag needsAI se confianca baixa.
 */
export function extractPipeline(texto) {
  const resultado = parseItau(texto);

  const needsAI = resultado.confianca_texto === 'baixa';

  return {
    success: true,
    transacoes: resultado.transacoes,
    total_encontrado: resultado.total_encontrado,
    valor_total: resultado.valor_total,
    banco_detectado: 'Itau',
    metodo: 'PARSER_DETERMINISTICO',
    auditoria: resultado.resumo_fatura,
    needsAI,
    metadados_verificacao: resultado.metadados_verificacao
  };
}

// ===== PROMPT IA =====

/**
 * Constroi prompt especifico para Itau quando o parser detecta texto intercalado.
 * Inclui metadados extraidos pelo parser para verificacao cruzada.
 *
 * @param {string} cartaoNome - Nome do cartao
 * @param {string} tipoCartao - Tipo do cartao (credito, debito, etc)
 * @param {object} metadados - Metadados extraidos pelo parser (total_fatura_pdf, subtotais, cartoes)
 * @returns {string} Prompt para a IA
 */
export function buildAIPrompt(cartaoNome, tipoCartao, metadados) {
  const totalFatura = metadados?.total_fatura_pdf
    ? `O valor total da fatura e R$ ${metadados.total_fatura_pdf.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}.`
    : '';

  const subtotaisInfo = metadados?.subtotais?.length > 0
    ? `\nSubtotais encontrados no PDF:\n${metadados.subtotais.map(s => `  - ${s.descricao}: R$ ${s.valor.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`).join('\n')}`
    : '';

  const cartoesInfo = metadados?.cartoes?.length > 0
    ? `\nCartoes presentes na fatura: ${metadados.cartoes.map(c => `final ${c}`).join(', ')}.`
    : '';

  return `Voce e um especialista em extrair transacoes de faturas de cartao de credito Itau.
Analise este PDF de fatura do cartao "${cartaoNome}"${tipoCartao ? ` (cartao ${tipoCartao})` : ''}.

<context>
Esta fatura Itau usa layout de duas colunas no PDF. O cartao titular aparece na coluna esquerda e o cartao adicional na coluna direita. Isso significa que o texto extraido automaticamente intercala as duas colunas, tornando o regex deterministico pouco confiavel. Por isso voce esta recebendo o PDF para leitura visual.

${totalFatura}${subtotaisInfo}${cartoesInfo}
</context>

<extraction_rules>
1. Extraia todas as transacoes de todos os cartoes presentes no PDF.
2. Inclua transacoes de todas as secoes: "compras e saques", "transacoes internacionais" e "outros lancamentos".
3. Para transacoes internacionais, use o valor ja convertido em BRL, porque e o valor efetivamente cobrado na fatura.
4. Cada transacao deve aparecer uma unica vez — duplicatas causam divergencia na reconciliacao.
5. Formate datas como DD/MM/YYYY, adicionando o ano com base na data de vencimento da fatura.
6. Valores devem ser numeros positivos (ex: 1234.56), sem formatacao brasileira.
</extraction_rules>

<classification>
Cada transacao deve ter um campo tipo_lancamento. Classifique assim:

- "compra": compras nacionais e internacionais (incluindo parceladas)
- "iof": IOF (Imposto sobre Operacoes Financeiras)
- "estorno": estornos, creditos na fatura, devolucoes, reembolsos, cashback
- "pagamento_antecipado": pagamento antecipado, pagamento parcial
- "tarifa_cartao": anuidade, tarifa do cartao, seguro fatura, avaliacao emergencial
</classification>

<items_to_exclude>
Nao inclua no JSON os seguintes itens, porque nao representam despesas da fatura:

- "Pagamento fatura", "Pagamento recebido", "Pagamento efetuado" — sao pagamentos feitos pelo cliente para quitar a fatura anterior
- Linhas de subtotal, total e saldo anterior — sao agregacoes, nao transacoes individuais
- Cabecalhos de secoes — sao apenas titulos organizacionais
</items_to_exclude>

<reconciliation>
Para validar a extracao, confira que a soma:
  compras + iof + tarifa_cartao - estornos - pagamento_antecipado
seja proxima de ${metadados?.total_fatura_pdf ? `R$ ${metadados.total_fatura_pdf.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : 'o total da fatura no PDF'}.
Se houver divergencia significativa, revise se alguma transacao foi esquecida ou duplicada.
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
  "total_encontrado": numero,
  "valor_total": soma_apenas_das_compras,
  "banco_detectado": "Itau"
}
</output_format>`;
}

// ===== POS-PROCESSAMENTO IA =====

/**
 * Aplica correcoes pos-IA nas transacoes retornadas pela IA.
 *
 * 1. filtrarTransacoesIA() - remove subtotais, pagamentos, limites incluidos por engano
 * 2. corrigirEstornosIA() - reclassifica estornos mal-classificados como compra
 *
 * @param {Array} transacoes - Transacoes retornadas pela IA
 * @param {object} metadados - Metadados extraidos pelo parser (contem total_fatura_pdf)
 * @returns {Array} Transacoes corrigidas
 */
export function postAICorrections(transacoes, metadados) {
  // 1. Filtrar transacoes que nao sao transacoes reais
  let corrigidas = filtrarTransacoesIA(transacoes);

  // 2. Corrigir estornos mal-classificados como compra
  const totalFaturaPDF = metadados?.total_fatura_pdf || null;
  corrigidas = corrigirEstornosIA(corrigidas, totalFaturaPDF);

  return corrigidas;
}

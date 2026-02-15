/**
 * Pipeline: Mercado Pago (Metadados + IA Visual Obrigatoria)
 *
 * Parser para faturas de cartao de credito Mercado Pago.
 *
 * Problema central: faturas Mercado Pago usam CIDFont com encoding customizado.
 * Os caracteres internos do PDF sao substituidos — por exemplo:
 *   Visual: "PAYPAL *FACEBOOKSER R$ 3.958,18"
 *   pdf-parse: "PóKPóL B5óíEZOOGSE$ $4 +J%39,19"
 *
 * Isso torna a extracao de texto via pdf-parse/regex fundamentalmente impossivel
 * para transacoes. A unica forma confiavel e a IA visual (Claude le o PDF renderizado).
 *
 * Estrategia (metadata-only + IA visual):
 *   1. Extrai metadados do texto quando possivel (total bruto, cartoes, ano)
 *   2. NAO tenta capturar transacoes (texto corrompido)
 *   3. SEMPRE retorna needsAI: true para forcar IA visual
 *   4. IA visual recebe metadados para verificacao cruzada
 *   5. postAICorrections aplica filtros e correcao de estornos
 *
 * Caracteristicas Mercado Pago:
 * - Encoding CIDFont corrompido (caracteres substituidos em valores e nomes)
 * - Pagina 1: Resumo (Total a pagar, Consumos, Tarifas) — sem transacoes
 * - Pagina 2: "Movimentacoes na fatura" (pagamentos + tarifas) + inicio transacoes
 * - Paginas 2-6: Transacoes do cartao distribuidas em blocos de ~8 por pagina
 * - Cada bloco termina com "Total R$ X.XXX,XX" — TOTAL GERAL, nao subtotal
 * - Pagina 7+: Parcelamento, info do cartao, termos legais — sem transacoes
 * - Transacoes com mesma data e estabelecimento podem ter valores diferentes (nao sao duplicatas)
 * - Parcelamentos: "Parcela X de Y" em coluna separada
 *
 * Interface padrao de pipeline:
 *   extractPipeline(texto, options)  - extrai metadados, retorna zero transacoes, needsAI=true
 *   buildAIPrompt(...)               - prompt especializado para IA visual
 *   postAICorrections(...)           - filtragem + correcao de estornos pos-IA
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

export const BANK_ID = 'mercadopago';

// ===== HELPERS DE METADADOS =====

/**
 * Detecta se o texto extraido pelo pdf-parse esta com encoding corrompido.
 *
 * Faturas Mercado Pago usam CIDFont com mapeamento customizado. O sintoma
 * principal e "$4" aparecendo em vez de "R$" e "J" em vez de "." nos valores.
 *
 * Tabela de substituicao conhecida:
 *   R → $, $ → 4, 3 → 5, 4 → M, 5 → 3, 7 → ), 8 → 9, 9 → %, . → J
 *
 * @param {string} texto - Texto extraido pelo pdf-parse
 * @returns {object} { corrompido: boolean, indicadores: number }
 */
function detectarEncodingCorrompido(texto) {
  let indicadores = 0;

  // "$4" em vez de "R$" — indicador mais forte
  if (/\$4\s+\d/.test(texto)) indicadores += 3;

  // "J" como separador de milhares (ex: "12J495" em vez de "12.495")
  if (/\d{1,3}J\d{3}/.test(texto)) indicadores += 2;

  // Caracteres tipicos do encoding corrompido em contexto de fatura
  if (/PóKPóL|5óíEZOOG|zE\$íóõO/i.test(texto)) indicadores += 2;

  // "aJmJ" ou "aJaJ" (indicador de "a.m." / "a.a." corrompido)
  if (/aJmJ|aJaJ/.test(texto)) indicadores += 1;

  return {
    corrompido: indicadores >= 3,
    indicadores
  };
}

/**
 * Extrai finais de cartao presentes na fatura.
 *
 * Padroes reconhecidos:
 *   - "Cartão Visa [************5415]" (visual)
 *   - "Cartão Visa" ou "Cart" seguido de digitos (texto corrompido)
 *
 * @param {string} texto - Texto extraido do PDF
 * @returns {string[]} Array de finais de cartao (ex: ["5415"])
 */
function extrairCartoes(texto) {
  const cartoes = new Set();

  // Padrao visual: Cartao Visa [****5415]
  const regexCartao = /Cart[aã]o\s+(?:Visa|Master)\s*\[[\*]+(\d{4})\]/gi;
  let match;
  while ((match = regexCartao.exec(texto)) !== null) {
    cartoes.add(match[1]);
  }

  // Padrao corrompido: pode aparecer como "5415" apos asteriscos
  const regexAsteriscos = /\*{4,}(\d{4})\]/g;
  while ((match = regexAsteriscos.exec(texto)) !== null) {
    cartoes.add(match[1]);
  }

  return [...cartoes];
}

/**
 * Extrai o total BRUTO da fatura (Consumos + Tarifas e encargos).
 *
 * O "Total a pagar" no PDF Mercado Pago e o valor LIQUIDO (apos creditos
 * de pagamentos anteriores). Para reconciliacao, precisamos do valor BRUTO
 * que e comparavel com a soma das transacoes extraidas.
 *
 * NOTA: Com encoding corrompido, os valores aparecem como "$4 12J%)%,6+"
 * em vez de "R$ 12.979,63". Os labels ("Consumos de", "Tarifas e encargos")
 * tambem podem estar parcialmente corrompidos. Estas regex tentam capturar
 * ambos os formatos, mas o fallback principal e a IA visual.
 *
 * FIX v2: Regex agora usa [\s\S]{0,80} em vez de \s+ entre o label e o
 * valor para lidar com quebras de linha inseridas pelo pdf-parse quando
 * label e valor estao em posicoes diferentes da pagina.
 *
 * @param {string} texto - Texto extraido do PDF
 * @returns {object|null} { consumos, tarifas, bruto } ou null
 */
function extrairTotalBrutoFatura(texto) {
  let totalConsumos = 0;
  let totalTarifas = 0;

  // ---------------------------------------------------------------
  // CONSUMOS
  // ---------------------------------------------------------------

  // Tentar formato normal primeiro (caso raro de encoding OK)
  const regexConsumosNormal = /Consumos?\s+(?:de\s+)?\d{1,2}\/\d{1,2}\s+a\s+\d{1,2}\/\d{1,2}[\s\S]{0,80}?R\$\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i;
  const matchConsumosNormal = regexConsumosNormal.exec(texto);
  if (matchConsumosNormal) {
    totalConsumos = parseValorBR(matchConsumosNormal[1]);
  }

  // Tentar formato corrompido: "íonsumos de 16/12 a 13/01 $4 12J%)%,6+"
  // FIX: [\s\S]{0,80}? em vez de \s+ para lidar com quebras de linha
  // entre o label (ex: "íonsumos de 16/12 a 13/01") e o valor (ex: "$4 12J%)%,6+")
  // que pdf-parse pode extrair em linhas separadas.
  // O {0,80} limita a busca para evitar matches falsos em texto distante.
  if (totalConsumos === 0) {
    const regexConsumosCorrupt = /[ií]onsumos?\s+(?:de\s+)?\d{1,2}\/\d{1,2}\s+a\s+\d{1,2}\/\d{1,2}[\s\S]{0,80}?\$4\s+([\d,J%\+\)\(M]+)/i;
    const matchCorrupt = regexConsumosCorrupt.exec(texto);
    if (matchCorrupt) {
      const valorDecodificado = decodificarValorCorrompido(matchCorrupt[1]);
      if (valorDecodificado > 0) {
        totalConsumos = valorDecodificado;
      }
    }
  }

  // ---------------------------------------------------------------
  // TARIFAS
  // ---------------------------------------------------------------

  // Tentar tarifas formato normal
  // FIX: mesma correcao — [\s\S]{0,40}? para lidar com quebras de linha
  const regexTarifasNormal = /Tarifas?\s+e\s+encargos?[\s\S]{0,40}?R\$\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i;
  const matchTarifasNormal = regexTarifasNormal.exec(texto);
  if (matchTarifasNormal) {
    totalTarifas = parseValorBR(matchTarifasNormal[1]);
  }

  // Tentar tarifas formato corrompido
  // FIX: [\s\S]{0,40}? em vez de \s+
  if (totalTarifas === 0) {
    const regexTarifasCorrupt = /Tarifas?\s+e\s+encargos?[\s\S]{0,40}?\$4\s+([\d,J%\+\)\(M]+)/i;
    const matchTarifasCorrupt = regexTarifasCorrupt.exec(texto);
    if (matchTarifasCorrupt) {
      const valorDecodificado = decodificarValorCorrompido(matchTarifasCorrupt[1]);
      if (valorDecodificado > 0) {
        totalTarifas = valorDecodificado;
      }
    }
  }

  if (totalConsumos > 0) {
    const bruto = parseFloat((totalConsumos + totalTarifas).toFixed(2));
    console.log(`[Mercado Pago Pipeline] Total bruto: consumos=${totalConsumos}, tarifas=${totalTarifas}, bruto=${bruto}`);
    return { consumos: totalConsumos, tarifas: totalTarifas, bruto };
  }

  return null;
}

/**
 * Tenta decodificar um valor monetario com encoding corrompido.
 *
 * Tabela de substituicao do CIDFont Mercado Pago (visual → corrompido):
 *   0→0, 1→1, 2→2, 3→5, 4→M, 5→3, 6→6, 7→), 8→9, 9→%, .→J, ,→,
 *
 * Invertendo (corrompido → visual):
 *   0→0, 1→1, 2→2, 3→5, 5→3, 6→6, 9→8, %→9, M→4, )→7, J→., +→3
 *
 * FIX v2: Corrigido mapeamento de '+' → '3' (era '4' incorretamente).
 * Evidencia empirica via OCR:
 *   "$4 +6,+M"     = "R$ 36,34"    (MERCADOLIVRE: +→3, 6→6, +→3, M→4)
 *   "$4 12J%)%,6+" = "R$ 12.979,63" (Consumos: +→3 no ultimo digito)
 *   "$4 +%,%0"     = "R$ 39,90"    (APPLE.COM/BILL: +→3, %→9)
 *
 * @param {string} corrompido - Valor corrompido (ex: "12J%)%,6+")
 * @returns {number} Valor decodificado ou 0 se falhar
 */
function decodificarValorCorrompido(corrompido) {
  const mapa = {
    '0': '0', '1': '1', '2': '2', '3': '5', '5': '3',
    '6': '6', '9': '8', '%': '9', 'M': '4', ')': '7',
    'J': '.', ',': ',',
    '+': '3'  // FIX: era '4', correto e '3' (confirmado via OCR de multiplos valores)
  };

  let decodificado = '';
  for (const char of corrompido) {
    decodificado += mapa[char] || char;
  }

  // Tentar parsear como valor BR
  const valor = parseValorBR(decodificado);
  if (valor > 0) {
    console.log(`[Mercado Pago Pipeline] Valor decodificado: "${corrompido}" → "${decodificado}" → ${valor}`);
  }
  return valor;
}

/**
 * Extrai o total da fatura do PDF (valor LIQUIDO — "Total a pagar").
 *
 * ATENCAO: Este valor inclui creditos/pagamentos anteriores e NAO e
 * comparavel com a soma bruta das transacoes. Mantido como fallback
 * e para exibicao informativa.
 *
 * Tenta multiplos padroes, incluindo formatos com encoding limpo
 * (a capa do PDF Mercado Pago às vezes usa fonte nao-corrompida).
 *
 * @param {string} texto - Texto extraido do PDF
 * @returns {number|null} Valor liquido ou null
 */
function extrairTotalFaturaPDF(texto) {
  const padroes = [
    /TOTAL\s+DA\s+FATURA[\s\S]{0,30}?R\$\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i,
    /TOTAL\s+A\s+PAGAR[\s\S]{0,30}?R\$\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i,
    /Total\s+a\s+pagar[\s\S]{0,30}?R\$\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i,
    /VALOR\s+TOTAL[\s\S]{0,30}?R\$\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i,
  ];

  for (const regex of padroes) {
    const match = texto.match(regex);
    if (match) {
      const valor = parseValorBR(match[1]);
      if (valor > 0) return valor;
    }
  }

  return null;
}

/**
 * Extrai TODOS os campos do "Resumo da fatura" (pagina 1 do PDF).
 *
 * O resumo contem campos em encoding corrompido (Consumos, Tarifas, Saldo anterior,
 * Juros, Multas, Pagamentos) e um campo em encoding limpo (Total a pagar).
 *
 * Estes valores sao metadados do ciclo da fatura — NAO sao transacoes.
 * Sao usados na formula de reconciliacao completa:
 *   compras + tarifa_cartao + saldo_anterior + juros + multas - pagamento_fatura - estornos = total_a_pagar
 *
 * @param {string} texto - Texto extraido do PDF
 * @returns {object|null} Resumo completo ou null se nenhum campo extraido
 */
function extrairResumoFatura(texto) {
  const resumo = {
    consumos: 0,
    tarifas: 0,
    multas: 0,
    saldo_anterior: 0,
    juros_anterior: 0,
    pagamentos_creditos: 0,
    total_a_pagar: 0,
  };
  let camposExtraidos = 0;

  // Helper: tenta extrair valor corrompido ($4 VALOR) ou normal (R$ VALOR)
  function extrairCampo(regexCorrupt, regexNormal) {
    if (regexCorrupt) {
      const match = regexCorrupt.exec(texto);
      if (match) {
        const valor = decodificarValorCorrompido(match[1]);
        if (valor >= 0) return valor;
      }
    }
    if (regexNormal) {
      const match = regexNormal.exec(texto);
      if (match) {
        const valor = parseValorBR(match[1]);
        if (valor >= 0) return valor;
      }
    }
    return null;
  }

  // --- Consumos (ja extraido por extrairTotalBrutoFatura, mas queremos no resumo tambem) ---
  const consumos = extrairCampo(
    /[ií]onsumos?\s+(?:de\s+)?\d{1,2}\/\d{1,2}\s+a\s+\d{1,2}\/\d{1,2}[\s\S]{0,80}?\$4\s+([\d,J%\+\)\(M]+)/i,
    /Consumos?\s+(?:de\s+)?\d{1,2}\/\d{1,2}\s+a\s+\d{1,2}\/\d{1,2}[\s\S]{0,80}?R\$\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i
  );
  if (consumos !== null) { resumo.consumos = consumos; camposExtraidos++; }

  // --- Tarifas e encargos ---
  const tarifas = extrairCampo(
    /Tarifas?\s+e\s+encargos?[\s\S]{0,40}?\$4\s+([\d,J%\+\)\(M]+)/i,
    /Tarifas?\s+e\s+encargos?[\s\S]{0,40}?R\$\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i
  );
  if (tarifas !== null) { resumo.tarifas = tarifas; camposExtraidos++; }

  // --- Saldo anterior: "Total da fatura de debemêro" (mes corrompido) ---
  const saldoAnterior = extrairCampo(
    /Total da fatura de \w+[\s\S]{0,30}?\$4\s+([\d,J%\+\)\(M]+)/i,
    /Total da fatura de \w+[\s\S]{0,30}?R\$\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i
  );
  if (saldoAnterior !== null) { resumo.saldo_anterior = saldoAnterior; camposExtraidos++; }

  // --- Juros: "8uros do mDs anterior" (J corrompido para 8) ---
  const juros = extrairCampo(
    /[8J]uros do m[DdÊê]s anterior[\s\S]{0,30}?\$4\s+([\d,J%\+\)\(M]+)/i,
    /[Jj]uros do m[eê]s anterior[\s\S]{0,30}?R\$\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i
  );
  if (juros !== null) { resumo.juros_anterior = juros; camposExtraidos++; }

  // --- Multas: "zultas por atraso" (M corrompido para z) ---
  const multas = extrairCampo(
    /[zM]ultas por atraso[\s\S]{0,30}?\$4\s+([\d,J%\+\)\(M]+)/i,
    /[Mm]ultas por atraso[\s\S]{0,30}?R\$\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i
  );
  if (multas !== null) { resumo.multas = multas; camposExtraidos++; }

  // --- Pagamentos e creditos devolvidos ---
  const pagamentos = extrairCampo(
    /Pagamentos e cr[eé]ditos devolvidos[\s\S]{0,30}?\$4\s+([\d,J%\+\)\(M]+)/i,
    /Pagamentos e cr[eé]ditos devolvidos[\s\S]{0,30}?R\$\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i
  );
  if (pagamentos !== null) { resumo.pagamentos_creditos = pagamentos; camposExtraidos++; }

  // --- Total a pagar: encoding LIMPO (ultima linha do resumo da pagina 1) ---
  // Este campo usa fonte nao-corrompida no PDF Mercado Pago.
  //
  // CUIDADO: A regex generica "/Total\s+R\$/" capturaria o "Total R$ 12.979,63"
  // dos blocos de transacoes (que e o bruto repetido em cada pagina).
  // Precisamos capturar especificamente o "Total a pagar" ou o "Total" do
  // contexto do resumo da pagina 1, NAO o total dos blocos de cartao.
  //
  // Estrategia: tentar "Total a pagar" primeiro, depois "Total" no contexto
  // do resumo (proximo dos outros campos do resumo), e por fim qualquer "Total R$"
  // que NAO seja o valor de Consumos (para evitar pegar o bruto).
  const regexTotalAPagar = [
    /Total\s+a\s+pagar[\s\S]{0,30}?R\$\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i,
    /Total\s+R\$\s*(\d{1,3}(?:\.\d{3})*,\d{2})/,
  ];
  for (const regex of regexTotalAPagar) {
    const match = texto.match(regex);
    if (match) {
      const valor = parseValorBR(match[1]);
      // Se o valor e igual ao bruto de consumos, e o "Total" do bloco de cartao — pular
      if (valor > 0 && Math.abs(valor - resumo.consumos) > 1) {
        resumo.total_a_pagar = valor;
        camposExtraidos++;
        break;
      }
      // Se consumos nao foi extraido, aceitar qualquer valor
      if (valor > 0 && resumo.consumos === 0) {
        resumo.total_a_pagar = valor;
        camposExtraidos++;
        break;
      }
    }
  }

  if (camposExtraidos === 0) return null;

  console.log(`[Mercado Pago Pipeline] Resumo fatura extraido (${camposExtraidos} campos):`);
  console.log(`  consumos=${resumo.consumos}, tarifas=${resumo.tarifas}`);
  console.log(`  saldo_anterior=${resumo.saldo_anterior}, juros=${resumo.juros_anterior}, multas=${resumo.multas}`);
  console.log(`  pagamentos_creditos=${resumo.pagamentos_creditos}, total_a_pagar=${resumo.total_a_pagar}`);

  return resumo;
}

/**
 * Detecta o ano de referencia da fatura.
 *
 * @param {string} texto - Texto extraido do PDF
 * @returns {number} Ano de referencia (ex: 2026)
 */
function detectarAnoReferencia(texto) {
  // Tentar vencimento primeiro: "Vencimento: 20/01/2026" ou "20/01/2026"
  const matchVenc = texto.match(/[Vv]encimento[:\s]+(\d{2}\/\d{2}\/(\d{4}))/);
  if (matchVenc) return parseInt(matchVenc[2]);

  // Tentar qualquer data com ano: DD/MM/YYYY
  const matchData = texto.match(/(\d{2}\/\d{2}\/(\d{4}))/);
  if (matchData) {
    const ano = parseInt(matchData[2]);
    if (ano >= 2020 && ano <= 2030) return ano;
  }

  // Tentar "fatura de janeiro" + ano no contexto
  const matchFatura = texto.match(/(?:FATURA|VENCIMENTO).*?(\d{4})/i);
  if (matchFatura) {
    const ano = parseInt(matchFatura[1]);
    if (ano >= 2020 && ano <= 2030) return ano;
  }

  return new Date().getFullYear();
}

// ===== PIPELINE PRINCIPAL =====

/**
 * Extrai metadados de uma fatura Mercado Pago.
 *
 * Mercado Pago SEMPRE usa CIDFont com encoding corrompido, entao o parser
 * deterministico NUNCA conseguira extrair transacoes corretamente via regex.
 * Retorna ZERO transacoes + needsAI=true para SEMPRE forcar IA visual,
 * junto com metadados para o prompt da IA.
 *
 * @param {string} texto - Texto completo extraido do PDF
 * @param {object} [options={}] - Opcoes (nao usadas atualmente)
 * @returns {object} PipelineResult padrao com needsAI: true
 */
export function extractPipeline(texto, options = {}) {
  // 1. Detectar encoding corrompido (para logging e diagnostico)
  const encoding = detectarEncodingCorrompido(texto);
  console.log(`[Mercado Pago Pipeline] Encoding corrompido: ${encoding.corrompido} (indicadores: ${encoding.indicadores})`);

  // 2. Extrair ano de referencia
  const anoReferencia = detectarAnoReferencia(texto);
  console.log(`[Mercado Pago Pipeline] Ano referencia: ${anoReferencia}`);

  // 3. Extrair resumo completo da fatura (todos os campos da pagina 1)
  const resumo = extrairResumoFatura(texto);

  // 3b. Extrair totais (bruto e liquido) como fallback
  const totalBruto = extrairTotalBrutoFatura(texto);
  const totalLiquido = extrairTotalFaturaPDF(texto);

  // Para reconciliacao, usar TOTAL A PAGAR (liquido) do resumo.
  // A formula completa inclui saldo_anterior e pagamentos_fatura como componentes,
  // permitindo reconciliar contra o valor que o usuario ve na capa do PDF.
  //
  // Prioridade: resumo.total_a_pagar (liquido) > totalLiquido > totalBruto.bruto > null
  // O total_a_pagar e o valor da capa do PDF que o usuario ve.
  // Nunca usar o bruto como referencia primaria — ele nao inclui saldo/pagamentos.
  const totalParaReconciliacao = resumo?.total_a_pagar || totalLiquido || totalBruto?.bruto || null;

  if (resumo?.total_a_pagar) {
    console.log(`[Mercado Pago Pipeline] Total para reconciliacao (LIQUIDO/total_a_pagar): ${resumo.total_a_pagar}`);
  } else if (totalBruto?.bruto) {
    console.warn(`[Mercado Pago Pipeline] Resumo nao extraido — fallback para BRUTO: ${totalBruto.bruto}`);
  } else {
    console.warn(`[Mercado Pago Pipeline] AVISO: Nao foi possivel extrair total do texto corrompido.`);
    console.warn(`[Mercado Pago Pipeline] A reconciliacao dependera do valor retornado pela IA no campo total_a_pagar.`);
  }

  // 4. Detectar cartoes presentes
  const cartoes = extrairCartoes(texto);
  console.log(`[Mercado Pago Pipeline] Cartoes detectados: ${JSON.stringify(cartoes)}`);

  // 5. SEMPRE forcar IA visual — encoding corrompido impede parsing deterministico
  console.log('[Mercado Pago Pipeline] SEMPRE needsAI=true: Mercado Pago usa CIDFont com encoding corrompido — forcando IA visual');

  // Auditoria com zero transacoes + metadados do PDF
  const auditoria = calcularAuditoria([], totalParaReconciliacao);

  return {
    success: true,
    transacoes: [],           // ZERO transacoes — IA visual vai extrair
    total_encontrado: 0,
    valor_total: 0,
    banco_detectado: 'Mercado Pago',
    metodo: 'PARSER_DETERMINISTICO',
    auditoria,
    needsAI: true,            // SEMPRE true
    metadados_verificacao: {
      total_fatura_pdf: totalParaReconciliacao,    // Agora e o liquido (total_a_pagar) quando resumo disponivel
      total_liquido_pdf: resumo?.total_a_pagar || totalLiquido,
      subtotais_bruto: totalBruto,
      resumo_fatura: resumo,                       // Resumo completo para formula de reconciliacao
      cartoes,
      ano_referencia: anoReferencia,
      encoding_corrompido: encoding.corrompido,
    }
  };
}

// ===== INTERFACE IA =====

/**
 * Constroi prompt especializado para IA visual analisar fatura Mercado Pago.
 *
 * O prompt explica a estrutura exata do PDF (baseada em analise de faturas reais),
 * inclui metadados para verificacao cruzada, e instrui a IA a extrair transacoes
 * de todas as paginas, incluindo tarifas E pagamentos da secao "Movimentacoes".
 *
 * Pontos criticos do prompt:
 * - "Movimentacoes na fatura" contem pagamentos (tipo pagamento_fatura) E tarifas (tipo tarifa_cartao)
 * - Transacoes do cartao espalhadas em 4-6 paginas sob mesmo cabecalho
 * - "Total R$ X.XXX,XX" ao final de cada bloco e o TOTAL GERAL, nao subtotal
 * - Transacoes com mesma data/estabelecimento e valores diferentes NAO sao duplicatas
 * - total_a_pagar e o valor LIQUIDO ("Total a pagar" da capa do PDF)
 * - Reconciliacao usa formula completa: compras + tarifas + saldo_anterior + juros + multas - pagamentos - estornos
 *
 * @param {string} cartaoNome - Nome do cartao (ex: "Visa final 5415")
 * @param {string} tipoCartao - Tipo do cartao (fisico, virtual, etc.)
 * @param {object} metadados - Metadados extraidos pelo extractPipeline
 * @returns {string} Prompt formatado para IA visual
 */
export function buildAIPrompt(cartaoNome, tipoCartao, metadados) {
  const anoRef = metadados?.ano_referencia || new Date().getFullYear();
  const resumo = metadados?.resumo_fatura;

  const cartoesInfo = metadados?.cartoes?.length > 0
    ? metadados.cartoes.map(c => `final ${c}`).join(', ')
    : null;

  // Montar bloco de metadados para verificacao cruzada
  let metadadosBloco = '';
  const totalBruto = metadados?.subtotais_bruto;
  const totalReconciliacao = metadados?.total_fatura_pdf;

  metadadosBloco = `
<metadados_pdf>
Dados extraidos automaticamente do PDF para verificacao cruzada:`;
  if (totalBruto) {
    metadadosBloco += `\n- Consumos do periodo: R$ ${totalBruto.consumos?.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
    metadadosBloco += `\n- Tarifas e encargos: R$ ${totalBruto.tarifas?.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
    metadadosBloco += `\n- Total bruto (Consumos + Tarifas): R$ ${totalBruto.bruto?.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
  }
  if (resumo) {
    metadadosBloco += `\n- Saldo anterior (fatura passada): R$ ${resumo.saldo_anterior?.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
    metadadosBloco += `\n- Juros do mes anterior: R$ ${resumo.juros_anterior?.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
    metadadosBloco += `\n- Multas por atraso: R$ ${resumo.multas?.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
    metadadosBloco += `\n- Pagamentos e creditos devolvidos: R$ ${resumo.pagamentos_creditos?.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
    metadadosBloco += `\n- Total a pagar (liquido): R$ ${resumo.total_a_pagar?.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
  }
  if (cartoesInfo) metadadosBloco += `\n- Cartoes presentes: ${cartoesInfo}`;
  metadadosBloco += `\n- Ano de referencia: ${anoRef}`;
  metadadosBloco += `\n</metadados_pdf>`;

  const totalAPagarStr = totalReconciliacao
    ? `R$ ${totalReconciliacao.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
    : 'o valor "Total a pagar" da pagina 1 do PDF';

  return `Voce e um especialista em extrair transacoes de faturas de cartao de credito Mercado Pago.
Analise este PDF de fatura do cartao "${cartaoNome}"${tipoCartao ? ` (cartao ${tipoCartao})` : ''} e extraia todas as transacoes.
${metadadosBloco}

<estrutura_pdf>
Faturas Mercado Pago tem a seguinte organizacao:

PAGINA 1 — RESUMO (nao contem transacoes individuais):
- "Total a pagar": valor LIQUIDO da fatura (inclui saldo anterior, pagamentos, juros, multas)
- "Resumo da fatura": Consumos do periodo, Tarifas e encargos, Multas, Total da fatura anterior, Pagamentos e creditos devolvidos
- O valor "Consumos de DD/MM a DD/MM" e o total BRUTO das compras do cartao
- Opcoes de parcelamento e pagamento minimo — NAO sao transacoes

PAGINA 2 — MOVIMENTACOES NA FATURA + INICIO DAS TRANSACOES:
- Secao "Movimentacoes na fatura": contem itens que DEVEM ser extraidos:
  a) "Pagamento da fatura de [mes]/[ano]" → tipo "pagamento_fatura" (pagamentos feitos pelo cliente)
  b) "Tarifa de uso do credito emergencial" ou outras tarifas → tipo "tarifa_cartao"
- Secao "Cartao Visa [****XXXX]": inicio das transacoes reais do cartao

PAGINAS 2 a 6 — TRANSACOES DO CARTAO (distribuidas em multiplas paginas):
- As transacoes de um mesmo cartao aparecem em blocos de ~8 transacoes por pagina
- Cada bloco repete o cabecalho "Cartao Visa [****XXXX]" e termina com "Total R$ X.XXX,XX"
- O "Total" que aparece ao final de cada bloco e o TOTAL GERAL de consumos do cartao inteiro, NAO um subtotal daquela pagina. Ele se repete identico em todas as paginas. IGNORE esses totais.
- As transacoes de TODAS as paginas pertencem ao mesmo cartao

PAGINAS 7+ — INFORMACOES FINANCEIRAS (nao contem transacoes):
- Opcoes de parcelamento de fatura
- Informacoes do cartao (limites, saques, lancamentos futuros)
- Termos legais e contatos
</estrutura_pdf>

<regras_extracao>
1. Extraia TODAS as transacoes individuais de TODAS as paginas de "Detalhes de consumo".
2. Da secao "Movimentacoes na fatura", extraia TODOS os itens:
   a) "Pagamento da fatura de [mes]/[ano]" → tipo "pagamento_fatura" (sao creditos/pagamentos feitos pelo cliente)
   b) "Tarifa de uso do credito emergencial" → tipo "tarifa_cartao" (sao debitos)
3. Use o ano ${anoRef} para completar datas que aparecem apenas como DD/MM.
4. Cada transacao deve ter: data, descricao, valor, parcela e tipo_lancamento.

Sobre transacoes que parecem duplicadas:
- E NORMAL ter multiplas transacoes com a mesma data e mesmo estabelecimento mas valores DIFERENTES.
  Exemplo: 6x "PAYPAL *FACEBOOKSER" no dia 17/12 com valores distintos (R$ 3.958,18, R$ 153,21, R$ 154,17, etc.)
  Essas NAO sao duplicatas — sao transacoes separadas que devem ser incluidas individualmente.
- So considere duplicata se data, descricao E valor forem IDENTICOS.

Classificacao de tipo_lancamento (obrigatoria em cada transacao):
- "compra": compras normais em lojas, sites, assinaturas, parcelamentos, servicos.
- "iof": linhas contendo "IOF" (Imposto sobre Operacoes Financeiras).
- "estorno": estornos, creditos na fatura, devolucoes, reembolsos, cashback, bonificacoes.
  Valores negativos no PDF sao estornos. Capture-os com valor positivo e tipo "estorno".
- "tarifa_cartao": tarifas do cartao, anuidade, seguro fatura, tarifa emergencial.
  "Tarifa de uso do credito emergencial" da secao Movimentacoes = tarifa_cartao.
- "pagamento_fatura": pagamentos da fatura anterior feitos pelo cliente.
  Aparecem na secao "Movimentacoes na fatura" como "Pagamento da fatura de [mes]/[ano]".
  Capture com valor POSITIVO. Sao creditos que REDUZEM o saldo da fatura.
- "pagamento_antecipado": pagamento antecipado de parcelas futuras.
</regras_extracao>

<o_que_ignorar>
NAO inclua no JSON nenhum dos itens abaixo:
- Linhas de "Total" que aparecem ao final de cada bloco de cartao (sao o total geral repetido)
- Subtotais e somas parciais
- Saldo anterior e limites de credito (estes sao metadados do resumo, nao transacoes)
- Informacoes financeiras: juros, CET, parcelamento de fatura, credito rotativo
- Opcoes de pagamento (pagamento minimo, parcelamento)
- Lancamentos futuros, compras parceladas a vencer
- Endereco, codigo de barras, dados de correspondencia, termos legais
</o_que_ignorar>

<reconciliacao>
Para verificar se a extracao esta completa e correta, use a formula completa do ciclo:

  soma(compras) + soma(iof) + soma(tarifa_cartao) + saldo_anterior + juros + multas
  - soma(pagamento_fatura) - soma(estornos) - soma(pagamento_antecipado)
  = total a pagar (liquido)

O total a pagar esperado e ${totalAPagarStr}.
${resumo ? `
Valores do resumo da pagina 1 para verificacao cruzada:
- Saldo anterior (fatura do mes passado): R$ ${resumo.saldo_anterior?.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
- Juros do mes anterior: R$ ${resumo.juros_anterior?.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
- Multas por atraso: R$ ${resumo.multas?.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
- Pagamentos e creditos devolvidos: R$ ${resumo.pagamentos_creditos?.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
` : ''}
NOTA: Os valores de saldo_anterior, juros e multas sao metadados extraidos do resumo da pagina 1
e serao inseridos automaticamente na formula. Voce NAO precisa criar transacoes para eles.
Voce SO precisa extrair como transacoes: compras, tarifas, pagamentos da fatura e estornos.

Se a diferenca entre o calculado e o esperado for maior que R$ 5,00, revise:
- Verifique se os "Pagamento da fatura de [mes]" foram incluidos como tipo pagamento_fatura
- Verifique se a "Tarifa de uso do credito emergencial" foi incluida como tarifa_cartao
- Verifique se todas as paginas de transacoes foram processadas (transacoes continuam por 4-5 paginas)
- Verifique se transacoes com mesma data/estabelecimento mas valores diferentes foram incluidas separadamente
</reconciliacao>

<formato_saida>
Retorne apenas um JSON valido, sem markdown e sem comentarios:
{
  "transacoes": [
    {
      "data": "DD/MM/YYYY",
      "descricao": "descricao da transacao como aparece no PDF",
      "valor": 123.45,
      "parcela": "13/18" ou null,
      "tipo_lancamento": "compra"
    }
  ],
  "total_encontrado": numero_total_de_transacoes,
  "valor_total": soma_apenas_das_compras,
  "banco_detectado": "Mercado Pago",
  "total_a_pagar": valor_liquido_total_a_pagar_da_pagina_1
}

Regras do JSON:
- "data": formato DD/MM/YYYY, usando o ano ${anoRef}. Se a data for DD/MM sem ano, adicione ${anoRef}. Datas de dezembro usam ${anoRef - 1} se o vencimento for em janeiro/${anoRef}.
- "descricao": texto original da transacao como aparece no PDF (nomes de estabelecimentos).
- "valor": numero decimal positivo com ponto como separador (ex: 3958.18), mesmo para estornos e pagamentos.
- "parcela": string "X/Y" se houver parcela (ex: "13/18"), ou null se nao houver.
- "tipo_lancamento": obrigatoriamente uma das opcoes: "compra", "iof", "estorno", "tarifa_cartao", "pagamento_fatura", "pagamento_antecipado".
- "total_encontrado": quantidade total de transacoes no array.
- "valor_total": soma apenas das transacoes com tipo_lancamento "compra".
- "banco_detectado": sempre "Mercado Pago".
- "total_a_pagar": valor LIQUIDO da fatura = "Total a pagar" da pagina 1 do PDF. Este e o valor que o cliente deve pagar, inclui saldo anterior, juros, multas e desconta pagamentos feitos.
</formato_saida>`;
}

// ===== POS-IA CORRECTIONS =====

/**
 * Aplica correcoes pos-IA nas transacoes extraidas.
 *
 * 1. filtrarTransacoesIA: remove entradas que nao sao transacoes reais
 *    (subtotais, saldos anteriores, pagamentos, limites)
 * 2. corrigirEstornosIA: corrige estornos mal-classificados como "compra"
 *    pela IA usando heuristica de divergencia
 *
 * @param {Array} transacoes - Transacoes retornadas pela IA
 * @param {Object} metadados - Metadados para verificacao (total_fatura_pdf)
 * @returns {Array} Transacoes corrigidas
 */
export function postAICorrections(transacoes, metadados) {
  let corrigidas = filtrarTransacoesIA(transacoes);
  corrigidas = corrigirEstornosIA(corrigidas, metadados?.total_fatura_pdf);
  return corrigidas;
}

// ===== BACKWARD COMPAT =====

/**
 * Funcao legada para compatibilidade com codigo existente.
 * Delega para extractPipeline e retorna no formato antigo.
 */
export function parseMercadoPago(texto) {
  const resultado = extractPipeline(texto);
  return {
    transacoes: resultado.transacoes,
    total_encontrado: resultado.total_encontrado,
    valor_total: resultado.valor_total,
    banco_detectado: resultado.banco_detectado,
  };
}

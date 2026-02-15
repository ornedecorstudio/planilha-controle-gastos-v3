/**
 * Pipeline C6 Bank - Parser deterministico de fatura de cartao de credito
 *
 * Caracteristicas:
 * - Multiplos cartoes (virtual, fisico, adicionais)
 * - Cada cartao tem sua propria secao de transacoes
 * - Transacoes internacionais com valor em USD + valor convertido em BRL + IOF separado
 * - Parcelamentos aparecem como "Parcela X/Y"
 * - Classifica cada transacao com tipo_lancamento:
 *   compra, iof, estorno, pagamento_antecipado, tarifa_cartao
 * - Extrai "Total a pagar" do resumo e constroi objeto de reconciliacao
 * - Deduplicacao via Set
 *
 * Formato de datas C6 Bank:
 *   O C6 Bank usa formato "DD mmm" (ex: "30 dez", "29 out", "15 nov")
 *   SEM espaco entre a abreviacao do mes e a descricao da transacao.
 *   Exemplo real: "05 janALIEXPRESS.COM161,19"
 *
 * Formato de IOF C6 Bank:
 *   IOF aparece como linha separada "IOF Transações Exterior" APOS a
 *   linha de valor do IOF. O valor do IOF e uma linha com formato
 *   normal de transacao, mas a proxima linha e "IOF Transações Exterior".
 *
 * Interface pipeline:
 *   - extractPipeline(texto, options)
 *   - buildAIPrompt(cartaoNome, tipoCartao, metadados) -> prompt de extracao para IA (fallback)
 *   - postAICorrections(transacoes) -> passthrough
 */

import { parseValorBR, parseDataBR, extrairParcela, calcularAuditoria } from '../utils.js';

// ===== CONSTANTES DE CLASSIFICACAO =====

const BANK_ID = 'c6bank';

// Meses abreviados para regex DD mmm
const MESES_RE = '(?:jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)';

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
  'BONIFICACAO'
];

const keywordsTarifaCartao = [
  'ANUIDADE',
  'TARIFA CARTAO',
  'TARIFA DO CARTAO',
  'SEGURO FATURA',
  'FATURA SEGURA'
];

// Termos a ignorar completamente (nao geram transacao)
const ignorar = [
  'PAGAMENTO FATURA',
  'PAGAMENTO RECEBIDO',
  'INCLUSAO DE PAGAMENTO',
  'INCLUSÃO DE PAGAMENTO',
  'ENCARGO',
  'JUROS',
  'MULTA'
];

// ===== CLASSIFICACAO DE TIPO_LANCAMENTO =====

/**
 * Classifica uma descricao de transacao em tipo_lancamento.
 * Ordem de prioridade:
 *   1. pagamento_antecipado
 *   2. estorno
 *   3. iof
 *   4. tarifa_cartao (ANTES de ignorar, como Itau)
 *   5. ignorar (retorna null)
 *   6. compra (default)
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
    return null; // sinaliza que deve ser pulado
  }
  return 'compra';
}

// ===== EXTRACAO DE TOTAL DA FATURA =====

/**
 * Extrai o "Total a pagar" do texto do PDF.
 * Busca padroes como "Total a pagar R$ 13.651,74" ou "Total a pagarR$ 13.651,74" (sem espaco).
 * Multiplos fallbacks para lidar com variacoes de encoding e formato do C6 Bank.
 */
function extrairTotalFaturaPDF(texto) {
  // Normalizar espaços Unicode e colapsar whitespace (incluindo \n) em espaço simples.
  // O pdf-parse frequentemente insere quebras de linha entre o rótulo e o valor,
  // ex: "Valor da fatura:\nR$ 13.651,74" — colapsar garante que os regexes funcionem.
  const textoNorm = texto
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/\s+/g, ' ');

  // Regex primário expandido com mais alternativas
  const regexTotalFatura = /(?:TOTAL\s+(?:A\s+)?PAGAR|VALOR\s+TOTAL\s+(?:DESTA\s+)?FATURA|TOTAL\s+DA\s+FATURA|VALOR\s+DA\s+FATURA)\s*:?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;

  let match;
  let ultimoValor = null;

  while ((match = regexTotalFatura.exec(textoNorm)) !== null) {
    ultimoValor = parseValorBR(match[1]);
  }
  if (ultimoValor !== null) {
    console.log(`[c6bank] Total extraido via regex primario: ${ultimoValor}`);
    return ultimoValor;
  }

  // Fallback 1: "chegou no valor de R$ X.XXX,XX" (texto marketing da primeira página C6)
  const regexValorDe = /(?:chegou\s+no\s+valor\s+de|valor\s+de)\s+R\$\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;
  while ((match = regexValorDe.exec(textoNorm)) !== null) {
    ultimoValor = parseValorBR(match[1]);
  }
  if (ultimoValor !== null) {
    console.log(`[c6bank] Total extraido via fallback "valor de": ${ultimoValor}`);
    return ultimoValor;
  }

  // Fallback 2: "Valor da fatura: R$ X.XXX,XX" (formato alternativo)
  const regexValorFatura = /VALOR\s+DA\s+FATURA\s*:?\s*R\$\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;
  while ((match = regexValorFatura.exec(textoNorm)) !== null) {
    ultimoValor = parseValorBR(match[1]);
  }
  if (ultimoValor !== null) {
    console.log(`[c6bank] Total extraido via fallback "Valor da fatura": ${ultimoValor}`);
    return ultimoValor;
  }

  console.log('[c6bank] Nenhum total da fatura encontrado no PDF');
  return ultimoValor;
}

// ===== EXTRACAO DE ANO DE REFERENCIA =====

/**
 * Detecta o ano de referencia da fatura a partir de datas no texto.
 * Procura por padroes como "Vencimento 01/02/2026" ou "Fechamento 2026"
 * ou "transações feitas até 23/01/26".
 */
function detectarAnoReferencia(texto) {
  // Padrao 1: Ano explicito no texto (Vencimento, Fechamento, Fatura)
  const matchAno = texto.match(/(?:FATURA|VENCIMENTO|FECHAMENTO).*?(\d{4})/i);
  if (matchAno) {
    return parseInt(matchAno[1]);
  }

  // Padrao 2: Data curta DD/MM/YY no texto (ex: "23/01/26")
  const matchDataCurta = texto.match(/transações?\s+feitas?\s+até\s+(\d{1,2})\/(\d{1,2})\/(\d{2})\b/i);
  if (matchDataCurta) {
    const anoShort = parseInt(matchDataCurta[3]);
    return anoShort > 50 ? 1900 + anoShort : 2000 + anoShort;
  }

  // Padrao 3: Data completa DD/MM/YYYY no texto
  const matchDataCompleta = texto.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (matchDataCompleta) {
    return parseInt(matchDataCompleta[3]);
  }

  return new Date().getFullYear();
}

// ===== SEPARACAO DESCRICAO / VALOR C6 =====

/**
 * Separa a descricao do valor em strings concatenadas do C6 Bank.
 *
 * O C6 Bank concatena tudo sem espacos: "ALIEXPRESS.COM161,19" ou
 * "PAYPAL *ALIPAY EUR     35151,26" (onde 35 faz parte do nome do merchant).
 *
 * Estrategia: encontrar TODOS os possiveis valores BR validos que terminam
 * na posicao final da string, e escolher o que deixa a descricao mais
 * consistente (com pelo menos 1 letra).
 *
 * Exemplos:
 *   "ALIEXPRESS.COM161,19"           → desc="ALIEXPRESS.COM", valor=161.19
 *   "PAYPAL *ALIPAY EUR     35151,26"→ desc="PAYPAL *ALIPAY EUR     35", valor=151.26
 *   "PAYPAL *ALIPAY EUR     355,29"  → desc="PAYPAL *ALIPAY EUR     35", valor=5.29
 *   "PRODUTOS GLOBO - Parcela 10/1227,90" → desc="PRODUTOS GLOBO - Parcela 10/12", valor=27.90
 *   "BRCARTPANDA1.649,00"            → desc="BRCARTPANDA", valor=1649.00
 */
function extrairDescricaoValorC6(texto) {
  texto = texto.trim();

  // Estrategia: usar o regex padrao para capturar o valor BR no final.
  // O regex \d{1,3}(?:\.\d{3})*,\d{2}$ e "greedy" no \d{1,3} mas
  // limitado a 1-3 digitos antes da virgula, entao pega no maximo "XXX,XX"
  // ou "X.XXX,XX" (com ponto de milhar).
  //
  // Para "ALIEXPRESS.COM161,19": captura "161,19", desc="ALIEXPRESS.COM" ✓
  // Para "BRCARTPANDA1.649,00": captura "1.649,00", desc="BRCARTPANDA" ✓
  // Para "PAYPAL *ALIPAY EUR     35151,26": captura "151,26", desc="...35" ✓
  //   (porque \d{1,3} = max 3 digitos = "151", nao "35151")
  // Para "PAYPAL *ALIPAY EUR     355,29": captura "5,29", desc="...35" ✓
  //   (porque \d{1,3} = "5", e "35" fica na descricao)
  //
  // PROBLEMA: "PRODUTOS GLOBO - Parcela 10/1227,90"
  //   captura "227,90" ou "27,90" dependendo do backtracking
  //   Na verdade: parcela=10/12, valor=27,90
  //   → tratado pelo bloco de parcela abaixo.

  const matchValor = texto.match(/(\d{1,3}(?:\.\d{3})*,\d{2})\s*$/);
  if (!matchValor) return { descricao: null, valor: 0 };

  const valorStr = matchValor[1];
  const valor = parseValorBR(valorStr);
  if (valor <= 0) return { descricao: null, valor: 0 };

  let descricao = texto.substring(0, texto.length - matchValor[0].length).trim();

  // A descricao deve ter pelo menos 1 letra
  if (!descricao || !descricao.match(/[a-zA-Z]/)) {
    return { descricao: null, valor: 0 };
  }

  // ===== CASO ESPECIAL: parcela colada ao valor =====
  // O C6 concatena tudo: "PRODUTOS GLOBO - Parcela 10/1227,90"
  // Regex captura "227,90" → descricao fica "PRODUTOS GLOBO - Parcela 10/1"
  //
  // Deteccao: descricao termina com "X/Y" onde X e Y sao numeros.
  // Se Y < X (ex: 10/1), provavelmente Y roubou digitos do valor.
  // Tentar mover digitos da descricao para o valor.
  const matchParcelaFinal = descricao.match(/(\d{1,2})\/(\d{1,2})$/);
  if (matchParcelaFinal) {
    const parteX = parseInt(matchParcelaFinal[1]);
    const parteY = parseInt(matchParcelaFinal[2]);

    // Se Y < X, provavelmente esta errado. Ex: 10/1 deveria ser 10/12
    // Mover o ultimo digito de Y para o inicio do valor
    if (parteY < parteX && matchParcelaFinal[2].length === 1) {
      // Tentar: remover o ultimo digito do Y e adicionar ao valor
      // Ex: desc="...10/1", valorStr="227,90" → tentar "10/12" + "27,90"
      const digitoMovido = matchParcelaFinal[2]; // "1"
      const novoValorStr = digitoMovido + valorStr; // "1227,90"
      // Agora tentar extrair parcela + valor dessa combinacao
      // O novoValorStr completo e "1227,90". Parcela Y seria "12", valor "27,90"
      for (let numDigitsY = 2; numDigitsY >= 1; numDigitsY--) {
        const novoY = novoValorStr.substring(0, numDigitsY);
        const valorReal = novoValorStr.substring(numDigitsY);
        if (valorReal.match(/^\d{1,3}(?:\.\d{3})*,\d{2}$/) &&
            parseInt(novoY) >= parteX && parseInt(novoY) <= 24) {
          const baseDesc = descricao.substring(0, descricao.length - matchParcelaFinal[0].length).trim();
          const novaDesc = baseDesc + ` ${matchParcelaFinal[1]}/${novoY}`;
          return { descricao: novaDesc, valor: parseValorBR(valorReal) };
        }
      }
    }
  }

  // Parcela incompleta (descricao termina com "X/")
  const matchParcelaPendente = descricao.match(/(\d{1,2})\/$/);
  if (matchParcelaPendente) {
    const parteX = matchParcelaPendente[1];
    for (let numDigits = 2; numDigits >= 1; numDigits--) {
      if (valorStr.length <= numDigits) continue;
      const parcelaY = valorStr.substring(0, numDigits);
      const valorReal = valorStr.substring(numDigits);
      if (valorReal.match(/^\d{1,3}(?:\.\d{3})*,\d{2}$/) &&
          parseInt(parcelaY) > 0 && parseInt(parcelaY) <= 24) {
        const novaDesc = descricao.substring(0, descricao.length - matchParcelaPendente[0].length).trim()
          + ` ${parteX}/${parcelaY}`;
        return { descricao: novaDesc, valor: parseValorBR(valorReal) };
      }
    }
  }

  // Remover eventual R$ residual no final da descricao
  descricao = descricao.replace(/\s*R?\$?\s*$/, '').trim();

  return { descricao, valor };
}

// ===== PARSER PRINCIPAL =====

/**
 * Parser deterministico de faturas C6 Bank.
 *
 * O formato C6 Bank e:
 *   "DD mmmDESCRICAOVALOR" — sem espacos entre mes, descricao e valor
 *   Exemplos reais:
 *     "05 janALIEXPRESS.COM161,19"
 *     "29 outALIEXPRESS - Estorno289,53"
 *     "30 dez      Inclusao de Pagamento15.428,21"
 *     "29 marPRODUTOS GLOBO - Parcela 10/1227,90"
 *
 * IOF aparece como label "IOF Transações Exterior" na linha SEGUINTE
 * ao valor do IOF. Portanto, se a proxima linha contem "IOF", a transacao
 * atual deve ser classificada como tipo_lancamento: "iof".
 *
 * @param {string} texto - Texto extraido do PDF
 * @returns {Object} Resultado com transacoes, totais e metadados
 */
export function parseC6Bank(texto) {
  const transacoes = [];
  const anoReferencia = detectarAnoReferencia(texto);

  // Dedup: C6 Bank pode ter transacoes legitimamente duplicadas (mesmo dia, mesma
  // descricao, mesmo valor — ex: 2x ALIEXPRESS R$ 204,52 no dia 06 jan).
  // Usamos um Map com contagem para permitir duplicatas reais do PDF enquanto
  // evitamos reprocessar a mesma linha.
  const transacaoContagem = new Map();

  /**
   * Tenta adicionar uma transacao a lista.
   * @param {boolean} forceIOF - Se true, forca tipo_lancamento para 'iof'
   * @param {number} lineIdx - Indice da linha no PDF (para dedup)
   */
  function adicionarTransacao(data, descricao, valor, parcela, forceIOF = false, lineIdx = -1) {
    descricao = descricao.replace(/\s+/g, ' ').trim();

    if (!descricao || descricao.length < 2) return false;

    const descUpper = descricao.toUpperCase();
    let tipoLancamento = classificarTipoLancamento(descUpper);

    // null = deve ser ignorado
    if (tipoLancamento === null) return false;

    // Override para IOF quando a proxima linha indica IOF
    if (forceIOF && tipoLancamento === 'compra') {
      tipoLancamento = 'iof';
    }

    if (data && descricao && valor > 0) {
      // Dedup via indice de linha: cada linha do PDF so pode gerar 1 transacao
      if (lineIdx >= 0) {
        const lineKey = `line:${lineIdx}`;
        if (transacaoContagem.has(lineKey)) return false;
        transacaoContagem.set(lineKey, true);
      }

      transacoes.push({ data, descricao, valor, parcela, tipo_lancamento: tipoLancamento });
      return true;
    }
    return false;
  }

  // ===== PADRAO PRINCIPAL C6: DD mmm sem espaco =====
  // Formato real: "DD mmmDESCRICAOVALOR" (sem espaco entre mes e descricao, e entre descricao e valor)
  //
  // Exemplos reais do PDF:
  //   "05 janALIEXPRESS.COM161,19"           → desc="ALIEXPRESS.COM", valor=161.19
  //   "20 janPAYPAL *ALIPAY EUR     35151,26" → desc="PAYPAL *ALIPAY EUR     35", valor=151.26
  //   "20 janPAYPAL *ALIPAY EUR     355,29"   → desc="PAYPAL *ALIPAY EUR     35", valor=5.29 (IOF)
  //   "29 marPRODUTOS GLOBO - Parcela 10/1227,90" → desc="PRODUTOS GLOBO - Parcela 10/12", valor=27.90
  //
  // Estrategia: encontrar o ponto de separacao descricao/valor de tras para frente.
  // O valor e o menor grupo de digitos valido como BR value no final da string,
  // desde que a descricao resultante nao fique vazia e tenha pelo menos 1 letra.
  const linhas = texto.split('\n').map(l => l.trim()).filter(l => l);
  const regexDataMes = new RegExp(`^(\\d{1,2})\\s+(${MESES_RE})\\s*(.+)$`, 'i');

  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i];
    const matchLinha = linha.match(regexDataMes);
    if (!matchLinha) continue;

    const [, dia, mes, resto] = matchLinha;
    const dataStr = `${dia} ${mes}`;
    const data = parseDataBR(dataStr, anoReferencia);

    if (!data) continue;

    // Verificar se a proxima linha e "IOF Transações Exterior"
    const isIOF = (i + 1 < linhas.length) &&
      /^IOF\s+Transa/i.test(linhas[i + 1]);

    // Extrair descricao e valor do "resto" (parte apos DD mmm)
    let { descricao: descFinal, valor: valorFinal } = extrairDescricaoValorC6(resto);
    if (!descFinal || valorFinal <= 0) continue;

    // ===== CASO ESPECIAL: IOF de linhas ALIPAY com merchant code "35" =====
    // PAYPAL *ALIPAY EUR linhas terminam com "35" (merchant code) colado ao valor.
    // Para transacoes normais (compras), o regex padrao \d{1,3},\d{2} funciona:
    //   "35151,26" → 151,26 (correto: compra R$ 151.26, "35" fica na desc)
    //   "35299,03" → 299,03 (correto: compra R$ 299.03)
    //
    // Para IOF, o regex captura demais digitos:
    //   "355,29" → regex da 355,29 (ERRADO: IOF e R$ 5.29, "35" e merchant code)
    //   "3510,47" → regex da 510,47 (ERRADO: IOF e R$ 10.47)
    //
    // Fix: quando e IOF e a descricao contém ALIPAY, reprocessar o valor
    // removendo o "35" merchant code do inicio dos digitos.
    if (isIOF && /ALIPAY/i.test(resto)) {
      const matchAlipayIOF = resto.match(/35(\d+,\d{2})\s*$/);
      if (matchAlipayIOF) {
        const valorIOF = parseValorBR(matchAlipayIOF[1]);
        if (valorIOF > 0) {
          // Recalcular descricao: tudo antes dos digitos do IOF + "35"
          const posDigitos = resto.lastIndexOf('35' + matchAlipayIOF[1]);
          if (posDigitos >= 0) {
            const novaDesc = resto.substring(0, posDigitos + 2).trim().replace(/\s*R?\$?\s*$/, '').trim();
            if (novaDesc.match(/[a-zA-Z]/)) {
              descFinal = novaDesc;
              valorFinal = valorIOF;
            }
          }
        }
      }
    }

    const parcela = extrairParcela(descFinal);
    adicionarTransacao(data, descFinal, valorFinal, parcela, isIOF, i);
  }

  // ===== FALLBACK: Transacoes DD/MM (outros formatos C6 mais antigos) =====
  // So usar se o padrao DD mmm nao encontrou nada
  if (transacoes.length === 0) {
    const regexNacional = /(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(.+?)\s+R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})\s*$/gm;
    let match;

    while ((match = regexNacional.exec(texto)) !== null) {
      const data = parseDataBR(match[1], anoReferencia);
      const descricao = match[2].trim();
      const valor = parseValorBR(match[3]);
      const parcela = extrairParcela(descricao);
      adicionarTransacao(data, descricao, valor, parcela);
    }
  }

  // ===== RECLASSIFICAR PAGAMENTO ANTECIPADO =====
  // O C6 Bank indica pagamento antecipado no "Resumo da fatura":
  //   "(-) 445,19Pagamento antecipado"
  // Mas o pagamento antecipado TAMBEM aparece como transacao com data no corpo
  // da fatura (ex: "23 janALIEXPRESS.COM445,19"). O resumo NAO inclui esse
  // valor em "Compras nacionais/internacionais", entao ele NAO e uma compra.
  //
  // Estrategia: encontrar o valor do pagamento antecipado no resumo, e
  // reclassificar a transacao correspondente (ultima compra com esse valor
  // exato) para tipo_lancamento 'pagamento_antecipado'.
  // Se nao encontrar match, adicionar como transacao sintetica.
  const matchPgtoAnt = texto.match(/\(-\)\s*(\d{1,3}(?:\.\d{3})*,\d{2})\s*Pagamento\s+antecipado/i);
  if (matchPgtoAnt) {
    const valorPgtoAnt = parseValorBR(matchPgtoAnt[1]);
    if (valorPgtoAnt > 0) {
      // Procurar a ULTIMA transacao do tipo 'compra' com valor exato
      let found = false;
      for (let j = transacoes.length - 1; j >= 0; j--) {
        if (transacoes[j].tipo_lancamento === 'compra' &&
            Math.abs(transacoes[j].valor - valorPgtoAnt) < 0.01) {
          transacoes[j].tipo_lancamento = 'pagamento_antecipado';
          found = true;
          break;
        }
      }

      // Fallback: se nao encontrou transacao correspondente, criar sintetica
      if (!found) {
        const matchFechamento = texto.match(/fechamento.*?(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i);
        let dataPgtoAnt = null;
        if (matchFechamento) {
          dataPgtoAnt = parseDataBR(`${matchFechamento[1]}/${matchFechamento[2]}/${matchFechamento[3]}`, anoReferencia);
        }
        if (!dataPgtoAnt) {
          dataPgtoAnt = parseDataBR('01/01', anoReferencia);
        }

        transacoes.push({
          data: dataPgtoAnt,
          descricao: 'Pagamento antecipado',
          valor: valorPgtoAnt,
          parcela: null,
          tipo_lancamento: 'pagamento_antecipado'
        });
      }
    }
  }

  // Extrair total da fatura do PDF
  const totalFaturaPDF = extrairTotalFaturaPDF(texto);

  // valor_total = total_compras para compatibilidade
  const totalCompras = transacoes
    .filter(t => t.tipo_lancamento === 'compra')
    .reduce((sum, t) => sum + t.valor, 0);

  const valorTotal = parseFloat(totalCompras.toFixed(2));

  return {
    transacoes,
    total_encontrado: transacoes.length,
    valor_total: valorTotal,
    banco_detectado: 'C6 Bank',
    total_fatura_pdf: totalFaturaPDF
  };
}

// ===== PIPELINE INTERFACE =====

/**
 * extractPipeline - Ponto de entrada do pipeline.
 *
 * Executa o parser deterministico parseC6Bank e calcula auditoria.
 * Se o parser deterministico extrai menos de 3 transacoes, sinaliza
 * needsAI=true para que o route.js use a IA visual como fallback.
 */
export function extractPipeline(texto, options = {}) {
  const resultado = parseC6Bank(texto);
  const auditoria = calcularAuditoria(resultado.transacoes, resultado.total_fatura_pdf);

  const MIN_TRANSACOES = 3;
  const needsAI = resultado.transacoes.length < MIN_TRANSACOES;

  if (needsAI) {
    console.log(`[c6bank] Parser deterministico extraiu apenas ${resultado.transacoes.length} transacoes, sinalizando needsAI=true`);
  } else {
    console.log(`[c6bank] Parser deterministico extraiu ${resultado.transacoes.length} transacoes com sucesso`);
  }

  return {
    success: true,
    transacoes: resultado.transacoes,
    total_encontrado: resultado.total_encontrado,
    valor_total: resultado.valor_total,
    banco_detectado: 'C6 Bank',
    metodo: 'PARSER_DETERMINISTICO',
    auditoria,
    needsAI,
    metadados_verificacao: {
      total_fatura_pdf: resultado.total_fatura_pdf
    }
  };
}

/**
 * buildAIPrompt - Gera prompt de extracao para IA quando o parser deterministico
 * nao consegue extrair todas as transacoes.
 */
export function buildAIPrompt(cartaoNome, tipoCartao, metadados) {
  const totalFatura = metadados?.total_fatura_pdf
    ? `R$ ${metadados.total_fatura_pdf.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
    : null;

  let metadadosBloco = '';
  if (totalFatura) {
    metadadosBloco = `
<metadados_parser>
O parser deterministico extraiu os seguintes dados do PDF para verificacao cruzada:
- Total da fatura (Total a Pagar): ${totalFatura}
</metadados_parser>`;
  }

  return `Voce e um especialista em extrair transacoes de faturas de cartao de credito C6 Bank.
Analise este PDF de fatura do cartao "${cartaoNome}"${tipoCartao ? ` (cartao ${tipoCartao})` : ''} e extraia todas as transacoes.
${metadadosBloco}

<estrutura_pdf>
Faturas do C6 Bank podem conter multiplos cartoes (virtual, fisico, adicionais), e cada cartao tem sua propria secao de transacoes no PDF. Voce precisa extrair transacoes de todos os cartoes presentes.

Formato de datas do C6 Bank:
- O C6 Bank usa o formato "DD mmm" com abreviacoes de mes em portugues: jan, fev, mar, abr, mai, jun, jul, ago, set, out, nov, dez
- As datas aparecem SEM espaco entre o mes e a descricao: "05 janALIEXPRESS.COM161,19"
- Ao extrair, converta para DD/MM/YYYY usando o ano do vencimento da fatura

Formato tipico de cada transacao (texto extraido do PDF):
- Nacional: "DD mmmDESCRICAOVALOR" (ex: "14 janBRCARTPANDA1.649,00")
- Internacional: "DD mmmDESCRICAOVALOR" seguido de "USD XX,XX | Cotação USD: R$X,XX"
- IOF: aparece como linha "IOF Transações Exterior" APOS a linha com o valor do IOF
- Parcelamentos: "DD mmmDESCRICAO - Parcela X/YVALOR" (ex: "29 marPRODUTOS GLOBO - Parcela 10/1227,90")

Atencao: os valores estao quase sempre colados na descricao sem espaco. Separe corretamente.
</estrutura_pdf>

<regras_extracao>
1. Extraia transacoes de todos os cartoes presentes no PDF, sem duplicar nenhuma.
2. Para transacoes internacionais, use o valor convertido em BRL.
3. Datas devem estar no formato DD/MM/YYYY. Converta "DD mmm" para DD/MM/YYYY usando o ano do vencimento.
4. Valores devem ser numeros positivos (ex: 1234.56), mesmo para estornos.
5. IOF de transacoes internacionais e a linha ANTES de "IOF Transações Exterior" — capture o valor da linha anterior e classifique como "iof".
</regras_extracao>

<classificacao_tipo_lancamento>
Cada transacao precisa ter um campo tipo_lancamento. Isso e necessario para que a formula de reconciliacao funcione corretamente.

Os tipos possiveis sao:
- "compra": compras nacionais e internacionais, incluindo parcelamentos
- "iof": linhas seguidas por "IOF Transações Exterior"
- "estorno": estornos, creditos na fatura, devolucoes, reembolsos, cashback, bonificacoes
- "pagamento_antecipado": pagamento antecipado de parcelas ou pagamento parcial
- "tarifa_cartao": anuidade, tarifa do cartao, seguro fatura
</classificacao_tipo_lancamento>

<valores_negativos>
Valores precedidos por "-" (sinal de menos) no PDF representam estornos ou creditos.
Capture o valor como numero positivo no JSON. O campo tipo_lancamento "estorno" ja indica que e uma deducao.
Nunca classifique um valor negativo como "compra".
</valores_negativos>

<itens_ignorar>
Nao inclua no JSON os seguintes itens:
- "Inclusao de Pagamento" ou "Inclusão de Pagamento" (credito de pagamento anterior, nao uma transacao)
- "Pagamento de fatura" ou "Pagamento recebido"
- Subtotais de secao ("Subtotal", "Subtotal deste cartao")
- Saldo anterior, limite de credito, limite total
- Encargos, juros de mora, multa por atraso
- Cabecalhos de secao e informacoes de correspondencia
- Linhas "IOF Transações Exterior" (sao labels, nao transacoes — o valor do IOF esta na linha anterior)
</itens_ignorar>

<verificacao_cruzada>
A formula de reconciliacao e:
  compras + iof + tarifa_cartao - estornos - pagamento_antecipado = total da fatura

A soma deve ser proxima de ${totalFatura || 'o total da fatura indicado no PDF'}.
Se a diferenca for maior que R$ 5,00, revise os seguintes pontos comuns de erro:
- IOF classificado como "compra"
- Subtotais ou pagamentos de fatura incluidos por engano
- "Inclusao de Pagamento" incluido por engano
- Transacoes de algum cartao adicional que foram esquecidas
</verificacao_cruzada>

<formato_saida>
Retorne apenas um JSON valido, sem markdown e sem comentarios:
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
  "banco_detectado": "C6 Bank",
  "total_a_pagar": valor_total_da_fatura_conforme_indicado_no_PDF
}
O campo total_a_pagar e o "Total a pagar" ou "Total desta fatura" que aparece no resumo do PDF. Esse valor e usado para reconciliacao automatica.
</formato_saida>`;
}

/**
 * postAICorrections - Passthrough, nao aplica correcoes.
 */
export function postAICorrections(transacoes) {
  return transacoes;
}

// ===== EXPORTS =====

export { BANK_ID };

/**
 * Pipeline: PicPay (Deterministico Hibrido + IA Fallback)
 *
 * Parser para faturas de cartao de credito PicPay.
 *
 * Problema central: faturas PicPay usam layout de duas colunas no PDF.
 * Quando pdf-parse extrai o texto, gera linhas sem espacos entre campos
 * e pode duplicar transacoes entre colunas/paginas.
 *
 * Estrategia v4 (section-aware + value correction):
 *   1. Parseia texto por secoes de cartao (Picpay Card ... Subtotal)
 *   2. Corrige valores corrompidos (digitos do desc mesclados no valor)
 *   3. Usa subtotal por secao para deduplica intercalacao de colunas
 *   4. Extrai transacoes internacionais separadamente (USD->BRL)
 *   5. Classifica tipo_lancamento
 *   6. Se >= 3 transacoes: retorna resultado deterministico
 *   7. Se < 3: fallback para IA visual
 *
 * Corrupcoes de valor tratadas:
 *   A) PARC incompleto: "PARC06/0681,25" -> PARC06/06 + 81,25
 *   B) Valor com 0 inicial: "015,00" -> 15,00
 *   C) Digitos do desc colados: "BD22.497,67" -> BD2 + 2.497,67
 *
 * Interface padrao de pipeline:
 *   extractPipeline(texto, options)
 *   buildAIPrompt(...)
 *   postAICorrections(...)
 */

import { parseValorBR, calcularAuditoria, corrigirEstornosIA, filtrarTransacoesIA } from '../utils.js';

// ===== CONSTANTES =====

export const BANK_ID = 'picpay';

/**
 * Regex principal para transacoes nacionais.
 * Captura: DD/MM[0+ espacos]DESCRICAO[ultimo valor BRL da linha]
 *
 * pdf-parse do PicPay NAO insere espacos entre data/descricao/valor:
 *   "29/11PAGAMENTO DE FATURA PELO PICPA-119.594,07"
 *   "26/11ALIEXPRESS206,98"
 */
const TX_PATTERN = /^(\d{2}\/\d{2})\s*(.+?)(-?\d{1,3}(?:\.\d{3})*,\d{2})\s*$/;

/**
 * Descricoes de match individual que indicam falso positivo.
 */
const FALSE_POSITIVE_DESCRIPTIONS = ['Dólar:', 'Câmbio', 'DOLAR:', 'CAMBIO'];

/**
 * Linhas que devem ser COMPLETAMENTE ignoradas.
 */
const FULL_LINE_SKIP = [
  'Vencimento:',
  'Mastercard',
  'Página ',
  'Total geral dos lançamentos',
  'Total geral dos lancamentos',
];

/**
 * Descricoes de transacoes que devem ser excluidas do resultado final.
 */
const TRANSACOES_EXCLUIR = [
  'PAGAMENTO DE FATURA PELO PICPA',
  'PAGAMENTO DE FATURA PELO PICPAY',
  'PAGAMENTO DE FATURA',
  'PAGAMENTO RECEBIDO',
  'PAGAMENTO EFETUADO',
  'SUBTOTAL DOS LANCAMENTOS',
  'SUBTOTAL DOS LANÇAMENTOS',
  'TOTAL GERAL DOS LANCAMENTOS',
  'TOTAL GERAL DOS LANÇAMENTOS',
  'TOTAL DOS LANCAMENTOS',
  'TOTAL DOS LANÇAMENTOS',
];

/**
 * Contextos de parcelamento/financiamento (paginas 9-10 do PDF PicPay).
 */
const CONTEXTOS_PARCELAMENTO = [
  'PARCELA', 'JUROS', 'FINANC', 'CET ', 'A.M.', 'FIXAS',
  'PARCELAMENTO', 'IOF FINANC', 'TAXA DE JUROS',
  'ENCARGOS', 'EM AT', 'VALOR MINIMO', 'SALDO FINANCIADO',
  'CREDITO ROTATIVO'
];

// ===== CORRECAO DE VALORES CORROMPIDOS =====

/**
 * Corrige valores corrompidos pelo pdf-parse onde digitos da descricao
 * ou da parcela se mesclam com o valor.
 *
 * Casos tratados:
 * A) PARC incompleto: desc="EC *TICKETPARC06/0" valor="681,25"
 *    -> desc="EC *TICKETPARC06/06" valor="81,25"
 *
 * B) Valor com 0 inicial: desc="MEP*MAMBA NEGRA 20122" valor="015,00"
 *    -> desc="MEP*MAMBA NEGRA 201220" valor="15,00"
 *
 * C) Digitos do desc colados no valor: desc="FACEBK *H3M339RBD" valor="22.497,67"
 *    -> desc="FACEBK *H3M339RBD2" valor="2.497,67"
 *
 * @param {string} descricao
 * @param {string} valorStr - Valor como string no formato BR
 * @returns {{ desc: string, valor: string }}
 */
function corrigirValor(descricao, valorStr) {
  // Fix A: PARC incompleto — segundo numero tem 0 ou 1 digito
  const parcMatch = descricao.match(/PARC(\d{1,2})\/(\d?)$/i);
  if (parcMatch && parcMatch[2].length < 2) {
    for (let strip = 1; strip <= 3 && strip < valorStr.length; strip++) {
      const digitsToMove = valorStr.substring(0, strip);
      const newVal = valorStr.substring(strip).replace(/^\./, '');
      if (/^\d{1,3}(?:\.\d{3})*,\d{2}$/.test(newVal) && !/^0\d/.test(newVal)) {
        const newParcNum2 = parcMatch[2] + digitsToMove;
        const p1 = parseInt(parcMatch[1], 10);
        const p2 = parseInt(newParcNum2, 10);
        if (p2 > 0 && p1 <= p2) {
          const newDesc = descricao.replace(/PARC\d{1,2}\/\d?$/i, 'PARC' + parcMatch[1] + '/' + newParcNum2);
          return { desc: newDesc, valor: newVal };
        }
      }
    }
  }

  // Fix B: Valor comeca com 0 seguido de digito (ex: "015,00")
  if (/^0\d/.test(valorStr)) {
    const cleaned = valorStr.substring(1).replace(/^\./, '');
    if (/^\d{1,3}(?:\.\d{3})*,\d{2}$/.test(cleaned)) {
      return { desc: descricao + valorStr[0], valor: cleaned };
    }
  }

  // Fix C: Valor no formato XX.YYY,ZZ onde XX tem 2+ digitos
  // O primeiro digito pertence a descricao
  const leadingMatch = valorStr.match(/^(\d{2,})((?:\.\d{3})+,\d{2})$/);
  if (leadingMatch) {
    const [, leadDigits, rest] = leadingMatch;
    for (let strip = 1; strip < leadDigits.length; strip++) {
      const newVal = leadDigits.substring(strip) + rest;
      if (/^\d{1,3}(?:\.\d{3})*,\d{2}$/.test(newVal)) {
        return { desc: descricao + leadDigits.substring(0, strip), valor: newVal };
      }
    }
  }

  return { desc: descricao, valor: valorStr };
}

// ===== EXTRACAO POR SECAO DE CARTAO =====

/**
 * Parseia o texto em secoes de cartao, cada uma delimitada por
 * "Picpay Card..." e "Subtotal dos lancamentos XXX".
 *
 * @param {string} texto
 * @returns {Array<{name, start, end, txns, subtotal}>}
 */
function parsearSecoes(texto) {
  const linhas = texto.split('\n');
  const sections = [];
  let current = null;

  for (let i = 0; i < linhas.length; i++) {
    const trimmed = linhas[i].trim();

    // Inicio de secao de cartao
    if (/^Picpay Card/i.test(trimmed)) {
      if (current) sections.push(current);
      current = { name: trimmed, start: i, txns: [], subtotal: null, end: null };
    }

    // Subtotal fecha a secao
    const subMatch = trimmed.match(/Subtotal dos lan[çc]amentos\s*(-?\d{1,3}(?:\.\d{3})*,\d{2})/i);
    if (subMatch && current) {
      current.subtotal = parseFloat(subMatch[1].replace(/\./g, '').replace(',', '.'));
      current.end = i;
      sections.push(current);
      current = null;
      continue;
    }

    // Coletar transacoes dentro da secao
    if (current) {
      if (FULL_LINE_SKIP.some(s => trimmed.includes(s))) continue;
      if (/^D[oó]lar:/i.test(trimmed) || /^C[aâ]mbio\s+do\s+dia/i.test(trimmed)) continue;
      if (/^Data Estabelecimento/i.test(trimmed)) continue;
      if (/^Transações/i.test(trimmed)) continue;

      const m = trimmed.match(TX_PATTERN);
      if (!m) continue;

      let [, dataDDMM, desc, valorStr] = m;
      desc = desc.trim();

      // Filtrar falsos positivos
      if (FALSE_POSITIVE_DESCRIPTIONS.some(fp => desc.includes(fp))) continue;

      // Validar data
      const [dd, mm] = dataDDMM.split('/').map(Number);
      if (mm < 1 || mm > 12 || dd < 1 || dd > 31) continue;

      // Corrigir valor corrompido
      const corr = corrigirValor(desc, valorStr);
      desc = corr.desc;
      valorStr = corr.valor;

      // Parse valor
      const valorLimpo = valorStr.replace(/\./g, '').replace(',', '.');
      const valorOriginal = parseFloat(valorLimpo);
      if (isNaN(valorOriginal) || valorOriginal === 0) continue;

      const valor = Math.abs(valorOriginal);

      // Filtrar exclusoes
      const descUpper = desc.toUpperCase();
      if (TRANSACOES_EXCLUIR.some(e => descUpper.includes(e))) continue;

      current.txns.push({
        line: i,
        data: dataDDMM,
        descricao: desc,
        valor,
        valorOriginal,
      });
    }
  }

  if (current) sections.push(current);
  return sections;
}

/**
 * Deduplica transacoes dentro de uma secao usando o subtotal como budget.
 *
 * O subtotal do PDF = soma de TODAS as transacoes positivas da secao.
 * Se a soma positiva extraida excede o subtotal, temos duplicatas da
 * intercalacao de colunas. Remove duplicatas (mesmo data+desc+valor)
 * ate que a soma positiva fique proxima do subtotal.
 *
 * @param {Array} txns - Transacoes da secao
 * @param {number|null} subtotal - Subtotal do PDF para esta secao
 * @returns {Array} Transacoes sem duplicatas
 */
function deduplicarSecao(txns, subtotal) {
  if (!subtotal || subtotal <= 0) return txns;

  const positiveSum = txns.filter(t => t.valorOriginal > 0).reduce((a, t) => a + t.valorOriginal, 0);
  const tolerance = subtotal * 0.02;

  // Se soma positiva esta proxima do subtotal, sem dedup necessaria
  if (positiveSum <= subtotal + tolerance) return txns;

  console.log(`[PicPay Pipeline] Dedup secao: positiveSum=${positiveSum.toFixed(2)} > subtotal=${subtotal.toFixed(2)}`);

  // Contar ocorrencias de cada chave POSITIVA
  const keyCounts = {};
  for (const t of txns) {
    if (t.valorOriginal <= 0) continue;
    const key = t.data + '|' + t.descricao + '|' + t.valorOriginal.toFixed(2);
    keyCounts[key] = (keyCounts[key] || 0) + 1;
  }

  // Ordenar chaves duplicadas por valor (remove maiores primeiro)
  const dupeKeys = Object.entries(keyCounts)
    .filter(([, c]) => c > 1)
    .map(([k, c]) => ({ key: k, count: c, val: parseFloat(k.split('|')[2]) }))
    .sort((a, b) => b.val - a.val);

  let result = [...txns];
  let currentPosSum = positiveSum;

  for (const dk of dupeKeys) {
    if (currentPosSum <= subtotal + tolerance) break;

    // Remover ocorrencias extras (de tras pra frente, mantem a primeira)
    for (let i = result.length - 1; i >= 0; i--) {
      if (currentPosSum <= subtotal + tolerance) break;
      if (result[i].valorOriginal <= 0) continue;

      const key = result[i].data + '|' + result[i].descricao + '|' + result[i].valorOriginal.toFixed(2);
      if (key !== dk.key) continue;

      // Verificar se ha pelo menos outra instancia
      const otherExists = result.some((t, j) => j !== i && t.valorOriginal > 0 &&
        (t.data + '|' + t.descricao + '|' + t.valorOriginal.toFixed(2)) === dk.key);
      if (!otherExists) continue;

      console.log(`[PicPay Pipeline] Removida duplicata: ${dk.key} (linha ${result[i].line})`);
      currentPosSum -= result[i].valorOriginal;
      result.splice(i, 1);
    }
  }

  console.log(`[PicPay Pipeline] Apos dedup: ${result.length} txns, posSum=${currentPosSum.toFixed(2)}`);
  return result;
}

// ===== EXTRACAO DE TRANSACOES INTERNACIONAIS =====

/**
 * Extrai transacoes internacionais do texto.
 *
 * No pdf-parse do PicPay, transacoes internacionais aparecem em 4-5 linhas:
 *   "19/12"
 *   "ALIEXPRESS"
 *   "Dólar: 72,32"
 *   "Câmbio do dia: R$ 5,7918"
 *   "72,32418,86"
 *
 * @param {string} texto
 * @returns {{ transacoes: Array, linhasUsadas: Set<number> }}
 */
function extrairTransacoesInternacionais(texto) {
  const linhas = texto.split('\n');
  const transacoes = [];
  const linhasUsadas = new Set();

  for (let i = 0; i < linhas.length; i++) {
    const linhaTrimmed = linhas[i].trim();

    // Detectar linha "Dólar: XX,XX"
    const dolarMatch = linhaTrimmed.match(/^D[oó]lar:\s*(-?\d+,\d{2})$/);
    if (!dolarMatch) continue;

    const usdVal = parseFloat(dolarMatch[1].replace(',', '.'));
    const ehEstorno = usdVal < 0;

    // Procurar data e descricao nas linhas anteriores
    let dataDDMM = null;
    let descricao = '';
    let dataLineIdx = -1;

    if (i >= 2) {
      const linhaData = linhas[i - 2].trim();
      const linhaDsc = linhas[i - 1].trim();
      const dataMatch = linhaData.match(/^(\d{2}\/\d{2})$/);
      if (dataMatch) {
        dataDDMM = dataMatch[1];
        dataLineIdx = i - 2;
        descricao = linhaDsc;
      }
    }

    if (!dataDDMM && i >= 1) {
      const prev = linhas[i - 1].trim();
      const dataMatch = prev.match(/^(\d{2}\/\d{2})$/);
      if (dataMatch) {
        dataDDMM = dataMatch[1];
        dataLineIdx = i - 1;
        descricao = 'Transação Internacional';
      }
    }

    if (!dataDDMM) continue;

    // Procurar valor BRL (2 linhas apos "Dólar:")
    let brlVal = null;
    for (let j = i + 1; j <= Math.min(i + 2, linhas.length - 1); j++) {
      const valLine = linhas[j].trim();
      const brlMatch = valLine.match(/(-?\d{1,3}(?:\.\d{3})*,\d{2})\s*$/);
      if (brlMatch) {
        const parsed = parseFloat(brlMatch[1].replace(/\./g, '').replace(',', '.'));
        if (!isNaN(parsed)) {
          brlVal = parsed;
          linhasUsadas.add(j);
          break;
        }
      }
    }

    if (brlVal === null) continue;

    // Marcar linhas usadas
    if (dataLineIdx >= 0) linhasUsadas.add(dataLineIdx);
    if (i - 1 >= 0 && i - 1 !== dataLineIdx) linhasUsadas.add(i - 1);
    linhasUsadas.add(i);
    if (i + 1 < linhas.length) linhasUsadas.add(i + 1);

    const usdInfo = ` (USD ${Math.abs(usdVal).toFixed(2)})`;
    descricao = descricao + usdInfo;

    const valor = Math.abs(brlVal);
    const valorOriginal = ehEstorno ? -valor : valor;

    transacoes.push({
      data: dataDDMM,
      descricao,
      valor,
      valorOriginal,
    });
  }

  return { transacoes, linhasUsadas };
}

// ===== CLASSIFICACAO E FORMATACAO =====

/**
 * Classifica o tipo_lancamento de uma transacao.
 *
 * NOTA: tarifa_cartao e checado ANTES de IOF para que
 * "AJ A DEB TARIFA INTER IOF" seja classificado como tarifa, nao iof.
 */
function classificarTransacao(descricao, valorOriginal) {
  const d = descricao.toUpperCase();

  // Tarifas de cartao (antes de IOF para "AJ A DEB TARIFA INTER IOF")
  if (/ANUIDADE|TARIFA|SEGURO FATURA|AJ A DEB TARIFA/.test(d)) return 'tarifa_cartao';

  // IOF
  if (/\bIOF\b/.test(d)) return 'iof';

  // Estornos / creditos / devolucoes
  if (/ESTORNO|CR[EÉ]DITO|DEVOLU[CÇ][AÃ]O|CASHBACK|REEMBOLSO/.test(d)) return 'estorno';

  // Pagamento antecipado
  if (/PAGAMENTO ANTECIPADO|PGTO ANTECIPADO/.test(d)) return 'pagamento_antecipado';

  // Valor negativo no PDF
  if (valorOriginal < 0) return 'estorno';

  return 'compra';
}

/**
 * Extrai parcela da descricao e limpa.
 */
function extrairParcelaDescricao(descricao) {
  if (!descricao) return { parcela: null, descricaoLimpa: descricao };

  const parcMatch = descricao.match(/PARC(\d{1,2})\/(\d{1,2})/i);
  if (parcMatch) {
    const a = parseInt(parcMatch[1], 10);
    const t = parseInt(parcMatch[2], 10);
    if (a > 0 && t > 1 && a <= t && t <= 99) {
      const descricaoLimpa = descricao.replace(/PARC\d{1,2}\/\d{1,2}/i, '').trim();
      return { parcela: `${a}/${t}`, descricaoLimpa };
    }
  }

  return { parcela: null, descricaoLimpa: descricao };
}

// ===== EXTRACAO DE METADADOS =====

function emContextoParcelamento(textoUpper, posicao) {
  const vizinhanca = textoUpper.substring(
    Math.max(0, posicao - 300),
    Math.min(textoUpper.length, posicao + 100)
  );
  return CONTEXTOS_PARCELAMENTO.some(ctx => vizinhanca.includes(ctx));
}

function extrairTotalFaturaPDF(texto) {
  const textoUpper = texto.toUpperCase();
  const linhas = texto.split('\n');
  let match;

  // 1a. "Total da fatura" na mesma linha
  const regexTotal = /TOTAL\s+DA\s+FATURA\s*:?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;
  while ((match = regexTotal.exec(texto)) !== null) {
    if (!emContextoParcelamento(textoUpper, match.index)) {
      const valor = parseValorBR(match[1]);
      if (valor > 0) return valor;
    }
  }

  // 1b. "Total da fatura" na linha N, valor na linha N+1
  for (let i = 0; i < linhas.length - 1; i++) {
    if (/TOTAL\s+DA\s+FATURA/i.test(linhas[i].trim()) &&
        !emContextoParcelamento(textoUpper, texto.indexOf(linhas[i]))) {
      const proximaLinha = linhas[i + 1].trim();
      const matchValor = proximaLinha.match(/^R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})$/);
      if (matchValor) {
        const valor = parseValorBR(matchValor[1]);
        if (valor > 0) return valor;
      }
    }
  }

  // 2. "Total geral dos lancamentos"
  const regexTotalGeral = /TOTAL\s+GERAL\s+DOS\s+LAN[CÇ]AMENTOS\s*:?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;
  match = regexTotalGeral.exec(texto);
  if (match) {
    const valor = parseValorBR(match[1]);
    if (valor > 0) return valor;
  }

  // 3. "Valor total da fatura" (na mesma linha, formato "Valor total da faturaR$ 109.864,59")
  const regexValorTotal = /VALOR\s+TOTAL\s+DA\s+FATURA\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;
  match = regexValorTotal.exec(texto);
  if (match) {
    const valor = parseValorBR(match[1]);
    if (valor > 0) return valor;
  }

  // 4a. "Pagamento total" na mesma linha
  const regexPagTotal = /PAGAMENTO\s+TOTAL\s*:?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;
  while ((match = regexPagTotal.exec(texto)) !== null) {
    if (!emContextoParcelamento(textoUpper, match.index)) {
      const valor = parseValorBR(match[1]);
      if (valor > 0) return valor;
    }
  }

  // 4b. "Pagamento total" na linha N, valor na linha N+1
  for (let i = 0; i < linhas.length - 1; i++) {
    if (/PAGAMENTO\s+TOTAL/i.test(linhas[i].trim()) &&
        !emContextoParcelamento(textoUpper, texto.indexOf(linhas[i]))) {
      const proximaLinha = linhas[i + 1].trim();
      const matchValor = proximaLinha.match(/^R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})$/);
      if (matchValor) {
        const valor = parseValorBR(matchValor[1]);
        if (valor > 0) return valor;
      }
    }
  }

  console.log('[PicPay Pipeline] Nenhum total da fatura encontrado');
  return null;
}

function extrairSubtotais(texto) {
  const subtotais = [];
  const textoUpper = texto.toUpperCase();

  const regexSubtotal = /SUBTOTAL\s+DOS\s+LAN[CÇ]AMENTOS\s*:?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;
  let match;
  while ((match = regexSubtotal.exec(texto)) !== null) {
    if (emContextoParcelamento(textoUpper, match.index)) continue;
    const valor = parseValorBR(match[1]);
    if (valor > 0) subtotais.push({ descricao: 'Subtotal cartao', valor });
  }

  return subtotais;
}

function extrairCartoes(texto) {
  const cartoes = new Set();
  const regexFinal = /(?:CART[ÃA]O\s+)?FINAL\s+(\d{4})/gi;
  let match;
  while ((match = regexFinal.exec(texto)) !== null) cartoes.add(match[1]);
  if (/PICPAY\s+CARD(?!\s+FINAL)/i.test(texto)) cartoes.add('PRINCIPAL');
  return [...cartoes];
}

function extrairDespesasDoMes(texto) {
  const regex = /DESPESAS\s+DO\s+M[EÊ]S\s*:?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;
  const match = regex.exec(texto);
  if (match) return parseValorBR(match[1]);
  return null;
}

function extrairCreditosEstornos(texto) {
  const regex = /CR[EÉ]DITOS\s+E\s+ESTORNOS\s*:?\s*-?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;
  const match = regex.exec(texto);
  if (match) return parseValorBR(match[1]);
  return null;
}

// ===== PIPELINE PRINCIPAL =====

/**
 * Extrai transacoes e metadados de uma fatura PicPay.
 *
 * @param {string} texto - Texto completo extraido do PDF
 * @param {object} [options={}]
 * @returns {object} PipelineResult padrao
 */
export function extractPipeline(texto, options = {}) {
  console.log('[PicPay Pipeline] v4 section-aware + value correction');
  // === 1. Extrair metadados ===
  const totalFaturaPDF = extrairTotalFaturaPDF(texto);
  const subtotais = extrairSubtotais(texto);
  const cartoesDetectados = extrairCartoes(texto);
  const despesasDoMes = extrairDespesasDoMes(texto);
  const creditosEstornos = extrairCreditosEstornos(texto);

  console.log(`[PicPay Pipeline] Total fatura PDF: ${totalFaturaPDF}`);
  console.log(`[PicPay Pipeline] Despesas do mes: ${despesasDoMes}`);
  console.log(`[PicPay Pipeline] Subtotais: ${JSON.stringify(subtotais)}`);

  const metadados_verificacao = {
    total_fatura_pdf: totalFaturaPDF,
    despesas_do_mes_pdf: despesasDoMes,
    creditos_estornos_pdf: creditosEstornos,
    subtotais,
    cartoes: cartoesDetectados,
  };

  // === 2. Extrair transacoes internacionais (antes das nacionais) ===
  const { transacoes: transacoesInternacionais } = extrairTransacoesInternacionais(texto);

  // === 3. Extrair transacoes nacionais por secao de cartao ===
  const sections = parsearSecoes(texto);
  let transacoesNacionais = [];

  for (const section of sections) {
    const deduped = deduplicarSecao(section.txns, section.subtotal);
    transacoesNacionais.push(...deduped);
  }

  console.log(`[PicPay Pipeline] Nacionais: ${transacoesNacionais.length}, Internacionais: ${transacoesInternacionais.length}`);

  // === 4. Combinar todas as transacoes ===
  let todasTransacoes = [...transacoesNacionais, ...transacoesInternacionais];

  // === 5. Classificar e extrair parcelas ===
  todasTransacoes = todasTransacoes.map(t => {
    const { parcela, descricaoLimpa } = extrairParcelaDescricao(t.descricao);
    return {
      data: t.data,
      descricao: descricaoLimpa,
      valor: t.valor,
      parcela,
      tipo_lancamento: classificarTransacao(t.descricao, t.valorOriginal),
    };
  });

  console.log(`[PicPay Pipeline] Total apos classificacao: ${todasTransacoes.length}`);

  // === 6. Decisao: deterministico ou IA? ===
  if (todasTransacoes.length >= 3) {
    console.log(`[PicPay Pipeline] Extracao deterministica: ${todasTransacoes.length} transacoes`);

    const auditoria = calcularAuditoria(todasTransacoes, totalFaturaPDF);
    auditoria.despesas_do_mes_pdf = despesasDoMes;
    auditoria.creditos_estornos_pdf = creditosEstornos;

    console.log(`[PicPay Pipeline] Reconciliacao: ${auditoria.reconciliado ? 'OK' : 'DIVERGENTE'} (diff: ${auditoria.diferenca_centavos} centavos)`);
    console.log(`[PicPay Pipeline] Equacao: ${auditoria.equacao}`);

    return {
      success: true,
      transacoes: todasTransacoes,
      total_encontrado: todasTransacoes.length,
      valor_total: todasTransacoes
        .filter(t => t.tipo_lancamento === 'compra')
        .reduce((sum, t) => sum + (t.valor || 0), 0),
      banco_detectado: 'PicPay',
      metodo: 'PARSER_DETERMINISTICO',
      auditoria,
      needsAI: false,
      metadados_verificacao,
    };
  }

  // Fallback IA
  console.log(`[PicPay Pipeline] Poucas transacoes (${todasTransacoes.length}), forcando IA visual`);

  const auditoria = calcularAuditoria([], totalFaturaPDF);
  auditoria.despesas_do_mes_pdf = despesasDoMes;
  auditoria.creditos_estornos_pdf = creditosEstornos;

  return {
    success: true,
    transacoes: todasTransacoes.length > 0 ? todasTransacoes : [],
    total_encontrado: todasTransacoes.length,
    valor_total: 0,
    banco_detectado: 'PicPay',
    metodo: 'PARSER_DETERMINISTICO',
    auditoria,
    needsAI: true,
    metadados_verificacao,
  };
}

// ===== INTERFACE IA (fallback) =====

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

IMPORTANTE: Sua resposta DEVE ser EXCLUSIVAMENTE um JSON valido. Nao inclua texto antes ou depois do JSON.

<context>
Este PDF PicPay usa layout de duas colunas lado a lado.
A fatura contem aproximadamente 200+ transacoes distribuidas em 7-8 paginas, com ${cartoesInfo ? metadados.cartoes.length : 'varios'} cartoes.
${metadadosBloco}
</context>

<extraction_rules>
1. Extraia TODAS as transacoes de TODOS os cartoes (${cartoesInfo || 'varios cartoes'}).
2. Percorra as paginas de 1 a 8 SEQUENCIALMENTE. Paginas 9-10 contem info financeira — ignore.
3. Para CADA pagina, leia AMBAS as colunas.
4. Se uma pagina for dificil de ler, extraia o maximo e continue.
</extraction_rules>

<classification>
- "compra": compras nacionais e internacionais
- "iof": IOF
- "estorno": estornos, creditos, devolucoes, cashback
- "pagamento_antecipado": pagamento antecipado
- "tarifa_cartao": anuidade, tarifa, seguro fatura, "AJ A DEB TARIFA"
</classification>

<items_to_exclude>
- "PAGAMENTO DE FATURA PELO PICPA" ou variacoes
- "Subtotal dos lancamentos", "Total geral dos lancamentos"
- Cabecalhos, milhas, info financeira pags 9-10
</items_to_exclude>

<output_format>
{
  "transacoes": [
    { "data": "DD/MM/YYYY", "descricao": "...", "valor": 123.45, "parcela": "1/3", "tipo_lancamento": "compra" }
  ],
  "total_encontrado": N,
  "valor_total": soma_compras,
  "banco_detectado": "PicPay"
}
</output_format>`;
}

export function postAICorrections(transacoes, metadados) {
  let corrigidas = filtrarTransacoesIA(transacoes);
  corrigidas = corrigirEstornosIA(corrigidas, metadados?.total_fatura_pdf);
  return corrigidas;
}

// ===== BACKWARD COMPAT =====

export function parsePicPay(texto) {
  const resultado = extractPipeline(texto);
  return {
    transacoes: resultado.transacoes,
    total_encontrado: resultado.total_encontrado,
    valor_total: resultado.valor_total,
    banco_detectado: resultado.banco_detectado,
    confianca_texto: resultado.needsAI ? 'baixa' : 'alta',
    cartoes_detectados: resultado.metadados_verificacao.cartoes,
    resumo_fatura: {
      total_compras: resultado.auditoria?.total_compras || 0,
      iof: resultado.auditoria?.iof || 0,
      estornos: resultado.auditoria?.estornos || 0,
      pagamento_antecipado: 0,
      tarifa_cartao: resultado.auditoria?.tarifa_cartao || 0,
      total_fatura_pdf: resultado.metadados_verificacao.total_fatura_pdf,
      total_fatura_calculado: resultado.auditoria?.total_fatura_calculado || 0,
      despesas_do_mes_pdf: resultado.metadados_verificacao.despesas_do_mes_pdf,
      creditos_estornos_pdf: resultado.metadados_verificacao.creditos_estornos_pdf,
      reconciliado: resultado.auditoria?.reconciliado || false,
      diferenca_centavos: resultado.auditoria?.diferenca_centavos || null,
      equacao: resultado.auditoria?.equacao || 'Parser PicPay pipeline v4',
      subtotais_pdf: resultado.metadados_verificacao.subtotais
    },
    metadados_verificacao: resultado.metadados_verificacao
  };
}

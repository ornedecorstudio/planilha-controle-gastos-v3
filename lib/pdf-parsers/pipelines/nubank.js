/**
 * Pipeline Nubank - Parser deterministico completo
 *
 * Formato tipico da fatura Nubank:
 * - Data: DD MMM (ex: "15 DEZ")
 * - Descricao em uma linha
 * - Valor: R$ X.XXX,XX ou apenas X.XXX,XX
 * - Parcelamentos: "PARCELA 2/10" ou similar
 * - Formato tabular alternativo: DD/MM ... R$ valor
 *
 * Classificacao tipo_lancamento:
 *   iof           -> IOF
 *   estorno       -> ESTORNO, CREDITO NA FATURA, DEVOLUCAO, REEMBOLSO, CASHBACK
 *   tarifa_cartao -> ANUIDADE, TARIFA, SEGURO FATURA, FATURA SEGURA
 *   pagamento_antecipado -> PAGAMENTO ANTECIPADO, PGTO ANTECIPADO
 *   compra        -> tudo o resto
 *
 * Ignora completamente (pagamentos do cliente):
 *   PAGAMENTO RECEBIDO, PAGAMENTO FATURA, PAGAMENTO EFETUADO
 */

import { parseValorBR, parseDataBR, extrairParcela, calcularAuditoria } from '../utils.js';

// ===== CONSTANTES DE CLASSIFICACAO =====

const KEYWORDS_PAGAMENTO_ANTECIPADO = [
  'PAGAMENTO ANTECIPADO',
  'PGTO ANTECIPADO'
];

const KEYWORDS_ESTORNO = [
  'ESTORNO',
  'CREDITO NA FATURA',
  'CREDITO FATURA',
  'DEVOLUCAO',
  'DEVOLUÇÃO',
  'REEMBOLSO',
  'CASHBACK'
];

const KEYWORDS_TARIFA_CARTAO = [
  'ANUIDADE',
  'TARIFA',
  'SEGURO FATURA',
  'FATURA SEGURA'
];

/** Transacoes que devem ser completamente ignoradas (pagamentos do cliente) */
const KEYWORDS_IGNORAR = [
  'PAGAMENTO RECEBIDO',
  'PAGAMENTO FATURA',
  'PAGAMENTO EFETUADO'
];

// ===== CLASSIFICACAO =====

/**
 * Classifica uma descricao de transacao em tipo_lancamento.
 *
 * Ordem de prioridade:
 *   1. pagamento_antecipado
 *   2. estorno
 *   3. iof
 *   4. tarifa_cartao
 *   5. ignorar (retorna null)
 *   6. compra (default)
 *
 * @param {string} descUpper - Descricao em maiusculas
 * @returns {string|null} tipo_lancamento ou null se deve ser ignorado
 */
function classificarTipoLancamento(descUpper) {
  // 1. Pagamento antecipado (verificar ANTES da lista ignorar)
  if (KEYWORDS_PAGAMENTO_ANTECIPADO.some(kw => descUpper.includes(kw))) {
    return 'pagamento_antecipado';
  }

  // 2. Estorno / credito
  if (KEYWORDS_ESTORNO.some(kw => descUpper.includes(kw))) {
    return 'estorno';
  }

  // 3. IOF
  if (descUpper.includes('IOF')) {
    return 'iof';
  }

  // 4. Tarifa / anuidade / seguro (capturar, nao ignorar)
  if (KEYWORDS_TARIFA_CARTAO.some(kw => descUpper.includes(kw))) {
    return 'tarifa_cartao';
  }

  // 5. Ignorar completamente (pagamentos do cliente)
  if (KEYWORDS_IGNORAR.some(termo => descUpper.includes(termo))) {
    return null;
  }

  // 6. Compra normal
  return 'compra';
}

// ===== EXTRACAO DO TOTAL DA FATURA =====

/**
 * Extrai o total da fatura do texto do PDF Nubank.
 *
 * Padroes buscados:
 *   "TOTAL DA SUA FATURA R$ X.XXX,XX"
 *   "Total da fatura R$ X.XXX,XX"
 *   "TOTAL R$ X.XXX,XX" (fora de contexto de parcela)
 *
 * @param {string} texto - Texto completo do PDF
 * @returns {number|null} Valor do total ou null se nao encontrado
 */
function extrairTotalFaturaPDF(texto) {
  // Padrao 1: "TOTAL DA SUA FATURA"
  const regexTotalSua = /TOTAL\s+DA\s+SUA\s+FATURA\s*:?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i;
  let match = regexTotalSua.exec(texto);
  if (match) {
    const valor = parseValorBR(match[1]);
    if (valor > 0) {
      console.log(`[Nubank Pipeline] Total extraido via "Total da sua fatura": ${valor}`);
      return valor;
    }
  }

  // Padrao 2: "TOTAL DA FATURA"
  const regexTotalDa = /TOTAL\s+DA\s+FATURA\s*:?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i;
  match = regexTotalDa.exec(texto);
  if (match) {
    const valor = parseValorBR(match[1]);
    if (valor > 0) {
      console.log(`[Nubank Pipeline] Total extraido via "Total da fatura": ${valor}`);
      return valor;
    }
  }

  // Padrao 3: "TOTAL R$ X.XXX,XX" — mais generico, evitar match em contexto de parcela
  // Busca "TOTAL" seguido de valor, mas NAO precedido por "PARCELA" ou "SUBTOTAL"
  const regexTotalGenerico = /(?<!PARCELA\s)(?<!SUB)TOTAL\s*:?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i;
  match = regexTotalGenerico.exec(texto);
  if (match) {
    const valor = parseValorBR(match[1]);
    if (valor > 0) {
      console.log(`[Nubank Pipeline] Total extraido via "TOTAL" generico: ${valor}`);
      return valor;
    }
  }

  console.log('[Nubank Pipeline] Nenhum total da fatura encontrado');
  return null;
}

// ===== PARSER PRINCIPAL =====

/**
 * Funcao raw de parsing Nubank, exportada para backward compat.
 *
 * @param {string} texto - Texto extraido do PDF
 * @returns {Object} Resultado do parsing com transacoes e metadados
 */
export function parseNubank(texto) {
  const transacoes = [];
  const linhas = texto.split('\n').map(l => l.trim()).filter(l => l);

  // Detectar ano da fatura
  let anoReferencia = new Date().getFullYear();
  const matchAno = texto.match(/(?:FATURA|VENCIMENTO).*?(\d{4})/i);
  if (matchAno) {
    anoReferencia = parseInt(matchAno[1]);
  }

  // Set para deduplicacao
  const transacoesUnicas = new Set();

  /**
   * Tenta adicionar uma transacao a lista.
   * Classifica tipo_lancamento e deduplica.
   *
   * @returns {boolean} true se adicionada, false se duplicata/ignorada
   */
  function adicionarTransacao(data, descricao, valor, parcela) {
    const descUpper = descricao.toUpperCase();
    const tipoLancamento = classificarTipoLancamento(descUpper);

    // null = deve ser ignorado (pagamento do cliente)
    if (tipoLancamento === null) return false;

    if (data && descricao && valor > 0) {
      const chave = `${data}|${descricao}|${valor.toFixed(2)}`;
      if (!transacoesUnicas.has(chave)) {
        transacoesUnicas.add(chave);
        transacoes.push({
          data,
          descricao: descricao.trim(),
          valor,
          parcela,
          tipo_lancamento: tipoLancamento
        });
        return true;
      }
    }
    return false;
  }

  // --- Padrao 1: "DD MMM" no inicio da linha ---
  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i];

    const matchData = linha.toUpperCase().match(
      /^(\d{1,2})\s+(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)/
    );

    if (matchData) {
      const dataStr = `${matchData[1]} ${matchData[2]}`;
      const data = parseDataBR(dataStr, anoReferencia);

      // Resto da linha apos a data e a descricao
      let descricao = linha.substring(matchData[0].length).trim();
      let valor = 0;
      let parcela = null;

      // Procura valor na mesma linha
      let valorMatch = descricao.match(/R?\$?\s*(\d{1,3}(?:\.\d{3})*(?:,\d{2})?)\s*$/);
      if (valorMatch) {
        valor = parseValorBR(valorMatch[1]);
        descricao = descricao.replace(valorMatch[0], '').trim();
      } else if (i + 1 < linhas.length) {
        // Valor pode estar na proxima linha
        const proximaLinha = linhas[i + 1];
        valorMatch = proximaLinha.match(/^R?\$?\s*(\d{1,3}(?:\.\d{3})*(?:,\d{2})?)\s*$/);
        if (valorMatch) {
          valor = parseValorBR(valorMatch[1]);
          i++; // Pula a linha do valor
        }
      }

      // Extrai parcela da descricao
      parcela = extrairParcela(descricao);

      adicionarTransacao(data, descricao, valor, parcela);
    }
  }

  // --- Padrao 2: Tabular DD/MM ... R$ valor ---
  const regexTabular = /(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(.+?)\s+R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/g;
  let matchTab;
  while ((matchTab = regexTabular.exec(texto)) !== null) {
    const data = parseDataBR(matchTab[1], anoReferencia);
    const descricao = matchTab[2].trim();
    const valor = parseValorBR(matchTab[3]);
    const parcela = extrairParcela(descricao);

    adicionarTransacao(data, descricao, valor, parcela);
  }

  // === Extrair total da fatura e calcular auditoria ===
  const totalFaturaPDF = extrairTotalFaturaPDF(texto);
  const auditoria = calcularAuditoria(transacoes, totalFaturaPDF);

  // valor_total = total_compras para compatibilidade
  const valorTotal = auditoria.total_compras;

  return {
    transacoes,
    total_encontrado: transacoes.length,
    valor_total: valorTotal,
    banco_detectado: 'Nubank',
    auditoria,
    metadados_verificacao: {
      total_fatura_pdf: totalFaturaPDF
    }
  };
}

// ===== PIPELINE INTERFACE =====

export const BANK_ID = 'nubank';

/**
 * Pipeline principal de extracao. Nubank usa parser deterministico
 * completo, sem necessidade de IA.
 *
 * @param {string} texto - Texto extraido do PDF
 * @param {Object} options - Opcoes do pipeline (nao usadas)
 * @returns {Object} PipelineResult padrao
 */
export function extractPipeline(texto, options = {}) {
  const resultado = parseNubank(texto);

  return {
    success: resultado.transacoes.length > 0,
    transacoes: resultado.transacoes,
    total_encontrado: resultado.total_encontrado,
    valor_total: resultado.valor_total,
    banco_detectado: 'Nubank',
    metodo: 'PARSER_DETERMINISTICO',
    auditoria: resultado.auditoria,
    needsAI: false,
    metadados_verificacao: resultado.metadados_verificacao
  };
}

/**
 * Gera prompt de extracao para a IA quando o parser deterministico
 * nao consegue extrair todas as transacoes (fallback).
 *
 * @param {string} cartaoNome - Nome do cartao
 * @param {string} tipoCartao - Tipo do cartao
 * @param {Object} metadados - Metadados extraidos: { total_fatura_pdf, subtotais, cartoes }
 * @returns {string} Prompt formatado para Claude
 */
export function buildAIPrompt(cartaoNome, tipoCartao, metadados) {
  const totalFatura = metadados?.total_fatura_pdf
    ? `R$ ${metadados.total_fatura_pdf.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
    : null;

  const subtotaisInfo = metadados?.subtotais?.length > 0
    ? metadados.subtotais.map(s => `  - ${s.descricao}: R$ ${s.valor.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`).join('\n')
    : null;

  const cartoesInfo = metadados?.cartoes?.length > 0
    ? metadados.cartoes.map(c => `final ${c}`).join(', ')
    : null;

  let metadadosBloco = '';
  if (totalFatura || subtotaisInfo || cartoesInfo) {
    metadadosBloco = `\n<metadados_verificacao>
O parser deterministico ja extraiu estes dados do PDF para verificacao cruzada:`;
    if (totalFatura) metadadosBloco += `\n- Total da fatura: ${totalFatura}`;
    if (cartoesInfo) metadadosBloco += `\n- Cartoes presentes: ${cartoesInfo}`;
    if (subtotaisInfo) metadadosBloco += `\n- Subtotais por cartao:\n${subtotaisInfo}`;
    metadadosBloco += '\nUse esses valores para conferir se todas as transacoes foram capturadas.\n</metadados_verificacao>';
  }

  return `Voce e um especialista em extrair transacoes de faturas de cartao de credito Nubank.
Analise este PDF de fatura do cartao "${cartaoNome}"${tipoCartao ? ` (cartao ${tipoCartao})` : ''}.
${metadadosBloco}

<estrutura_pdf>
A fatura Nubank segue este formato:
- Datas aparecem como "DD MMM" (ex: "15 DEZ", "03 JAN"). Converta para DD/MM/YYYY usando o ano de referencia da fatura.
- Valores estao em formato brasileiro: R$ 1.234,56 ou apenas 1.234,56. Converta para numero decimal (1234.56).
- Parcelamentos aparecem como "PARCELA 2/10" ou "2/10" junto a descricao.
- A fatura pode conter multiplos cartoes, cada um com sua secao de transacoes.
- Transacoes internacionais mostram o valor ja convertido em BRL.
</estrutura_pdf>

<regras_extracao>
Extraia todas as transacoes de todos os cartoes presentes no PDF.
Cada transacao precisa de um campo tipo_lancamento que indica sua natureza:

- "compra": compras nacionais e internacionais, incluindo parceladas. Este e o tipo padrao.
- "iof": IOF (Imposto sobre Operacoes Financeiras). Aparece como linha separada.
- "estorno": estornos, creditos na fatura, devolucoes, reembolsos, cashback. Qualquer valor que reduz a fatura.
- "pagamento_antecipado": pagamento antecipado ou parcial de parcelas futuras.
- "tarifa_cartao": anuidade, tarifa do cartao, seguro fatura, fatura segura.

A classificacao correta e essencial porque o sistema usa essa informacao para reconciliar o valor total da fatura.
</regras_extracao>

<valores_negativos>
Valores com sinal negativo no PDF representam estornos ou creditos. Capture-os com:
- tipo_lancamento: "estorno"
- valor: positivo (remova o sinal negativo)

Isso e necessario porque a formula de reconciliacao subtrai estornos do total. Se o valor fosse negativo e subtraido, a conta ficaria errada.
</valores_negativos>

<itens_ignorar>
Nao inclua no JSON os seguintes itens, pois nao sao transacoes reais:
- "Pagamento recebido", "Pagamento fatura", "Pagamento efetuado" (sao pagamentos feitos pelo cliente para quitar a fatura anterior)
- Linhas de subtotal e total (sao somas, nao transacoes individuais)
- Saldo anterior
- Limites de credito
- Informacoes de contato, endereco, codigo de barras
</itens_ignorar>

<reconciliacao>
Para conferir se a extracao esta completa, aplique esta formula:

  soma(compras) + soma(iof) + soma(tarifa_cartao) - soma(estornos) - soma(pagamento_antecipado) = total da fatura

O total da fatura e ${totalFatura || 'o valor mostrado no PDF como "Total da sua fatura"'}.
Se a soma ficar distante desse valor, revise se alguma transacao foi esquecida ou duplicada.
</reconciliacao>

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
  "banco_detectado": "Nubank"
}
</formato_saida>`;
}

/**
 * Nubank nao precisa de correcoes pos-IA — passthrough.
 *
 * @param {Array} transacoes - Transacoes retornadas pela IA
 * @param {Object} metadados - Metadados para verificacao
 * @returns {Array} Mesmas transacoes sem alteracao
 */
export function postAICorrections(transacoes, metadados) {
  return transacoes;
}

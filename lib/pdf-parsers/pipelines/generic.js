/**
 * Pipeline Generico - Fallback para bancos nao suportados
 *
 * Usado quando nenhum parser especifico detecta o banco.
 * Tenta multiplos padroes comuns em faturas brasileiras.
 *
 * Padroes de extracao (4):
 *   1. DATA | DESCRICAO | VALOR (regex inline, descricoes 3-60 chars)
 *   2. DD MMM (ex: "15 DEZ") com mapa de abreviacoes de meses
 *   3. Linha-a-linha: linhas iniciando com data, valor no final
 *   4. Internacional: DD/MM ... USD/EUR ... valor BRL
 *
 * Classificacao tipo_lancamento:
 *   iof                -> IOF
 *   estorno            -> ESTORNO, CREDITO NA FATURA, DEVOLUCAO, REEMBOLSO, CASHBACK
 *   tarifa_cartao      -> ANUIDADE, TARIFA CARTAO, SEGURO FATURA, FATURA SEGURA, AVAL EMERG
 *   pagamento_antecipado -> PAGAMENTO ANTECIPADO
 *   compra             -> tudo o resto
 *
 * Ignora completamente (nao geram transacao):
 *   PAGAMENTO FATURA, PAGAMENTO RECEBIDO, PAGAMENTO EFETUADO,
 *   SALDO ANTERIOR, TOTAL DA FATURA, VALOR TOTAL,
 *   LIMITE DISPONIVEL, LIMITE TOTAL
 *
 * Deduplicacao via Set com chave "data|descricao|valor"
 *
 * needsAI: true se < 3 transacoes encontradas (forca fallback IA)
 *
 * Interface pipeline:
 *   extractPipeline(texto, options)
 *   buildAIPrompt(cartaoNome, tipoCartao, metadados)
 *   postAICorrections(transacoes, metadados)
 */

import {
  parseValorBR,
  parseDataBR,
  extrairParcela,
  calcularAuditoria,
  filtrarTransacoesIA,
  corrigirEstornosIA
} from '../utils.js';

// ===== CONSTANTES DE CLASSIFICACAO =====

export const BANK_ID = 'desconhecido';

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
  'TARIFA CARTAO',
  'TARIFA DO CARTAO',
  'SEGURO FATURA',
  'FATURA SEGURA',
  'AVAL EMERG'
];

/** Transacoes que devem ser completamente ignoradas (pagamentos do cliente, totais, limites) */
const KEYWORDS_IGNORAR = [
  'PAGAMENTO FATURA',
  'PAGAMENTO RECEBIDO',
  'PAGAMENTO EFETUADO',
  'SALDO ANTERIOR',
  'TOTAL DA FATURA',
  'VALOR TOTAL',
  'LIMITE DISPONIVEL',
  'LIMITE TOTAL'
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

  // 2. Estorno / credito / devolucao / cashback
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

  // 5. Ignorar completamente (pagamentos do cliente, totais, limites)
  if (KEYWORDS_IGNORAR.some(termo => descUpper.includes(termo))) {
    return null;
  }

  // 6. Compra normal
  return 'compra';
}

// ===== EXTRACAO DO TOTAL DA FATURA =====

/**
 * Extrai o total da fatura do texto do PDF usando padroes genericos.
 *
 * Padroes buscados:
 *   "TOTAL DA FATURA R$ X.XXX,XX"
 *   "TOTAL A PAGAR R$ X.XXX,XX"
 *   "VALOR TOTAL R$ X.XXX,XX"
 *   "PAGAMENTO TOTAL R$ X.XXX,XX"
 *
 * @param {string} texto - Texto completo do PDF
 * @returns {number|null} Valor do total ou null se nao encontrado
 */
function extrairTotalFaturaPDF(texto) {
  const padroes = [
    /TOTAL\s+DA\s+FATURA\s*:?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i,
    /TOTAL\s+A\s+PAGAR\s*:?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i,
    /VALOR\s+TOTAL\s*:?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i,
    /PAGAMENTO\s+TOTAL\s*:?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i,
  ];

  for (const regex of padroes) {
    const match = texto.match(regex);
    if (match) {
      const valor = parseValorBR(match[1]);
      if (valor > 0) {
        console.log(`[Generic Pipeline] Total extraido: R$ ${valor}`);
        return valor;
      }
    }
  }

  console.log('[Generic Pipeline] Nenhum total da fatura encontrado');
  return null;
}

// ===== PARSER PRINCIPAL =====

/**
 * Parser deterministico generico de faturas de cartao de credito.
 *
 * Tenta 4 padroes de regex, deduplica via Set, classifica tipo_lancamento
 * e extrai total da fatura do PDF.
 *
 * @param {string} texto - Texto extraido do PDF
 * @returns {Object} Resultado com transacoes, totais e metadados
 */
export function parseGeneric(texto) {
  const transacoes = [];

  // Detectar ano da fatura
  let anoReferencia = new Date().getFullYear();
  const matchAno = texto.match(/(?:FATURA|VENCIMENTO|FECHAMENTO|ANO).*?(\d{4})/i);
  if (matchAno) {
    anoReferencia = parseInt(matchAno[1]);
  }

  // Set para evitar duplicatas
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

    // null = deve ser ignorado (pagamento do cliente, totais, limites)
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

  // ===== PADRAO 1: DATA | DESCRICAO | VALOR (formato mais comum) =====
  const regexPadrao1 = /(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(.{3,60}?)\s+R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/g;
  let match;

  while ((match = regexPadrao1.exec(texto)) !== null) {
    const data = parseDataBR(match[1], anoReferencia);
    const descricao = match[2].trim();
    const valor = parseValorBR(match[3]);
    const parcela = extrairParcela(descricao);

    // Ignora descricoes muito curtas/longas
    if (descricao.length < 3 || descricao.length > 80) continue;

    // Ignora cabecalhos
    const descUpper = descricao.toUpperCase();
    if (descUpper.includes('DATA') && descUpper.includes('DESCRI')) continue;

    adicionarTransacao(data, descricao, valor, parcela);
  }

  // ===== PADRAO 2: DD MMM (ex: "15 DEZ") =====
  const meses = {
    'JAN': '01', 'FEV': '02', 'MAR': '03', 'ABR': '04',
    'MAI': '05', 'JUN': '06', 'JUL': '07', 'AGO': '08',
    'SET': '09', 'OUT': '10', 'NOV': '11', 'DEZ': '12'
  };

  const regexPadrao2 = /(\d{1,2})\s+(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)\s+(.{3,60}?)\s+R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;

  while ((match = regexPadrao2.exec(texto)) !== null) {
    const dia = match[1].padStart(2, '0');
    const mes = meses[match[2].toUpperCase()];
    const data = `${anoReferencia}-${mes}-${dia}`;
    const descricao = match[3].trim();
    const valor = parseValorBR(match[4]);
    const parcela = extrairParcela(descricao);

    adicionarTransacao(data, descricao, valor, parcela);
  }

  // ===== PADRAO 3: Linha-a-linha (data no inicio, valor no final) =====
  const linhas = texto.split('\n').map(l => l.trim()).filter(l => l);

  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i];

    // Procura linha que comeca com data
    const matchData = linha.match(/^(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/);
    if (matchData) {
      const data = parseDataBR(matchData[1], anoReferencia);
      let resto = linha.substring(matchData[0].length).trim();

      // Procura valor no final da linha
      const matchValor = resto.match(/R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})\s*$/);
      if (matchValor) {
        const valor = parseValorBR(matchValor[1]);
        const descricao = resto.replace(matchValor[0], '').trim();

        if (descricao.length < 3) continue;

        adicionarTransacao(data, descricao, valor, extrairParcela(descricao));
      }
    }
  }

  // ===== PADRAO 4: Transacoes internacionais =====
  // DD/MM ... USD/EUR ... valor BRL
  const regexInternacional = /(\d{1,2}\/\d{1,2})\s+(.+?)\s+(?:USD|US\$|EUR|€)\s*[\d.,]+\s+(?:BRL|R\$)\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;

  while ((match = regexInternacional.exec(texto)) !== null) {
    const data = parseDataBR(match[1], anoReferencia);
    const descricao = match[2].trim();
    const valorBRL = parseValorBR(match[3]);

    adicionarTransacao(data, descricao, valorBRL, null);
  }

  // ===== CALCULOS FINAIS =====
  const totalFaturaPDF = extrairTotalFaturaPDF(texto);
  const auditoria = calcularAuditoria(transacoes, totalFaturaPDF);

  const valorTotal = transacoes
    .filter(t => t.tipo_lancamento === 'compra')
    .reduce((sum, t) => sum + t.valor, 0);

  return {
    transacoes,
    total_encontrado: transacoes.length,
    valor_total: parseFloat(valorTotal.toFixed(2)),
    banco_detectado: 'Genérico',
    auditoria,
    metadados_verificacao: {
      total_fatura_pdf: totalFaturaPDF
    }
  };
}

// ===== PIPELINE INTERFACE =====

/**
 * Pipeline principal de extracao para bancos desconhecidos.
 *
 * Executa o parser deterministico generico. Se menos de 3 transacoes
 * forem encontradas, sinaliza needsAI=true para forcar fallback IA.
 *
 * @param {string} texto - Texto extraido do PDF
 * @param {Object} options - Opcoes do pipeline (nao usadas)
 * @returns {Object} PipelineResult padrao
 */
export function extractPipeline(texto, options = {}) {
  const resultado = parseGeneric(texto);

  return {
    success: true,
    transacoes: resultado.transacoes,
    total_encontrado: resultado.total_encontrado,
    valor_total: resultado.valor_total,
    banco_detectado: 'Genérico',
    metodo: 'PARSER_DETERMINISTICO',
    auditoria: resultado.auditoria,
    needsAI: resultado.transacoes.length < 3,
    metadados_verificacao: resultado.metadados_verificacao
  };
}

/**
 * Constroi prompt generico para IA processar faturas de bancos desconhecidos.
 *
 * Pede a IA para extrair TODAS as compras de TODOS os cartoes,
 * classificar tipo_lancamento e usar BRL para internacionais.
 *
 * @param {string} cartaoNome - Nome do cartao
 * @param {string} tipoCartao - Tipo do cartao (credito, debito)
 * @param {Object} metadados - Metadados extraidos pelo parser
 * @returns {string} Prompt para a IA
 */
export function buildAIPrompt(cartaoNome, tipoCartao, metadados) {
  return `Voce e um especialista em extrair transacoes de faturas de cartao de credito brasileiras.
Analise este PDF de fatura do cartao "${cartaoNome}"${tipoCartao ? ` (cartao ${tipoCartao})` : ''} e extraia todas as transacoes.

<extraction_rules>
1. Extraia todas as compras e despesas de todos os cartoes presentes no PDF. Faturas podem conter cartao titular e adicionais.
2. Para transacoes internacionais, use o valor ja convertido em BRL, porque e o valor efetivamente cobrado na fatura brasileira.
3. Nao duplique transacoes — cada lancamento deve aparecer uma unica vez.
4. Datas no formato DD/MM/YYYY.
5. Valores como numeros positivos com ponto decimal (ex: 1234.56), conforme exigido pelo formato JSON.
</extraction_rules>

<classification>
Cada transacao deve ter um campo tipo_lancamento com um destes valores:

- "compra": compras nacionais e internacionais (incluindo parceladas). Este e o tipo padrao para a maioria dos lancamentos.
- "iof": IOF (Imposto sobre Operacoes Financeiras). Geralmente aparece logo apos transacoes internacionais.
- "estorno": estornos, creditos na fatura, devolucoes, reembolsos, cashback. Representa dinheiro devolvido ao cliente.
- "pagamento_antecipado": pagamento antecipado de parcelas futuras.
- "tarifa_cartao": anuidade, tarifa do cartao, seguro fatura. Sao cobracas do emissor do cartao, nao compras em estabelecimentos.
</classification>

<negative_values>
Valores com sinal negativo (-) no PDF representam estornos ou reembolsos.

Exemplo: "LOJA XYZ -110,95" → tipo_lancamento: "estorno", valor: 110.95

Valores negativos representam estornos/reembolsos — classifica-los como "compra" causaria divergencia de 2x o valor na reconciliacao. Capture o valor como numero positivo e classifique como "estorno". A classificacao "estorno" ja indica que e uma deducao.
</negative_values>

<items_to_exclude>
Nao inclua no JSON os seguintes itens, pois nao sao transacoes de gasto:
- "Pagamento fatura", "Pagamento recebido", "Pagamento de fatura": sao pagamentos do cliente ao banco. Incluir esses valores quebraria a reconciliacao com o total da fatura.
- Linhas de subtotal, total e saldo anterior: sao valores agregados, nao lancamentos individuais.
- Cartoes que contem apenas "pagamento de fatura" sem compras: ignore toda a secao desse cartao.
</items_to_exclude>

<output_format>
Retorne apenas um JSON valido, sem markdown:
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
  "banco_detectado": "nome do banco"
}
</output_format>`;
}

/**
 * Aplica correcoes pos-IA nas transacoes retornadas.
 *
 * 1. filtrarTransacoesIA: remove subtotais, pagamentos e limites que a IA
 *    pode ter incluido por engano
 * 2. corrigirEstornosIA: detecta e reclassifica estornos que a IA classificou
 *    como "compra" usando heuristica baseada na divergencia com o total do PDF
 *
 * @param {Array} transacoes - Transacoes retornadas pela IA
 * @param {Object} metadados - Metadados para verificacao (contem total_fatura_pdf)
 * @returns {Array} Transacoes corrigidas
 */
export function postAICorrections(transacoes, metadados) {
  const totalFaturaPDF = metadados?.total_fatura_pdf ?? null;
  const filtradas = filtrarTransacoesIA(transacoes);
  return corrigirEstornosIA(filtradas, totalFaturaPDF);
}

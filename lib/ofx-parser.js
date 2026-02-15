/**
 * Parser OFX (Open Financial Exchange) - Determinístico
 * Extrai movimentações de extratos bancários no formato OFX
 * Suporte: Itaú, Nubank, Santander, Bradesco, Inter, BB, Caixa
 */

/**
 * Extrai valor de uma tag OFX
 * @param {string} content - Bloco de texto OFX
 * @param {string} tag - Nome da tag (ex: 'TRNAMT')
 * @returns {string} Valor da tag ou string vazia
 */
function extractTag(content, tag) {
  // Formato OFX: <TAG>valor ou <TAG>valor</TAG>
  const regex = new RegExp(`<${tag}>([^<\\n]+)`, 'i');
  const match = content.match(regex);
  return match ? match[1].trim() : '';
}

/**
 * Converte data OFX (YYYYMMDDHHMMSS) para ISO (YYYY-MM-DD)
 * @param {string} ofxDate - Data no formato OFX (20260130100000)
 * @returns {string} Data no formato ISO (2026-01-30)
 */
function formatDate(ofxDate) {
  if (!ofxDate || ofxDate.length < 8) return null;
  const year = ofxDate.substring(0, 4);
  const month = ofxDate.substring(4, 6);
  const day = ofxDate.substring(6, 8);
  return `${year}-${month}-${day}`;
}

/**
 * Extrai informações do banco do OFX
 * @param {string} content - Conteúdo completo do OFX
 * @returns {object} Informações do banco
 */
function extractBankInfo(content) {
  const bankId = extractTag(content, 'BANKID');
  const acctId = extractTag(content, 'ACCTID');
  const acctType = extractTag(content, 'ACCTTYPE');

  // Mapear código do banco para nome
  const bancos = {
    '0341': 'Itaú',
    '341': 'Itaú',
    '260': 'Nubank',
    '033': 'Santander',
    '237': 'Bradesco',
    '077': 'Inter',
    '001': 'Banco do Brasil',
    '104': 'Caixa Econômica'
  };

  return {
    codigo: bankId,
    nome: bancos[bankId] || 'Outro',
    conta: acctId,
    tipo: acctType // CHECKING, SAVINGS, etc
  };
}

/**
 * Extrai período do extrato
 * @param {string} content - Conteúdo completo do OFX
 * @returns {object} Datas de início e fim
 */
function extractPeriod(content) {
  const dtStart = extractTag(content, 'DTSTART');
  const dtEnd = extractTag(content, 'DTEND');

  return {
    inicio: formatDate(dtStart),
    fim: formatDate(dtEnd)
  };
}

/**
 * Extrai saldo final do extrato
 * @param {string} content - Conteúdo completo do OFX
 * @returns {object} Saldo e data
 */
function extractBalance(content) {
  const balamt = extractTag(content, 'BALAMT');
  const dtasof = extractTag(content, 'DTASOF');

  return {
    saldo: parseFloat(balamt) || 0,
    data: formatDate(dtasof)
  };
}

/**
 * Parser principal de arquivos OFX
 * @param {string} content - Conteúdo do arquivo OFX
 * @returns {object} Dados estruturados do extrato
 */
export function parseOFX(content) {
  const movimentacoes = [];

  // Regex para capturar cada bloco de transação
  const transactionRegex = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;

  let match;
  while ((match = transactionRegex.exec(content)) !== null) {
    const block = match[1];

    const trnType = extractTag(block, 'TRNTYPE'); // CREDIT, DEBIT
    const dtPosted = extractTag(block, 'DTPOSTED'); // 20260130100000[-03:EST]
    const trnAmt = extractTag(block, 'TRNAMT'); // -3085.49 ou 11280.50
    const fitId = extractTag(block, 'FITID'); // ID único da transação
    const checkNum = extractTag(block, 'CHECKNUM'); // Número do documento
    const memo = extractTag(block, 'MEMO'); // Descrição

    // Converter valor para número
    const valor = parseFloat(trnAmt) || 0;

    // Ignorar linhas de saldo
    if (memo.toUpperCase().includes('SALDO')) {
      continue;
    }

    // Ignorar transações com valor zero
    if (valor === 0) {
      continue;
    }

    // Extrair data (remover timezone se presente)
    const dataClean = dtPosted.split('[')[0];

    movimentacoes.push({
      id: fitId,
      data: formatDate(dataClean),
      descricao: memo,
      valor: Math.abs(valor),
      tipo: valor < 0 ? 'saida' : 'entrada',
      tipo_ofx: trnType, // CREDIT ou DEBIT original
      documento: checkNum || fitId
    });
  }

  // Extrair informações gerais
  const banco = extractBankInfo(content);
  const periodo = extractPeriod(content);
  const saldo = extractBalance(content);

  return {
    success: true,
    banco: banco.nome,
    banco_codigo: banco.codigo,
    conta: banco.conta,
    tipo_conta: banco.tipo,
    periodo_inicio: periodo.inicio,
    periodo_fim: periodo.fim,
    saldo_final: saldo.saldo,
    data_saldo: saldo.data,
    total_movimentacoes: movimentacoes.length,
    movimentacoes
  };
}

/**
 * Valida se o conteúdo é um arquivo OFX válido
 * @param {string} content - Conteúdo do arquivo
 * @returns {boolean} True se for OFX válido
 */
export function isValidOFX(content) {
  if (!content || typeof content !== 'string') return false;

  // Verificar header OFX
  const hasHeader = content.includes('OFXHEADER') || content.includes('<OFX>');

  // Verificar estrutura básica
  const hasTransactions = content.includes('<STMTTRN>');
  const hasBankInfo = content.includes('<BANKACCTFROM>') || content.includes('<BANKID>');

  return hasHeader && (hasTransactions || hasBankInfo);
}

/**
 * Calcula totais do extrato
 * @param {array} movimentacoes - Lista de movimentações
 * @returns {object} Totais calculados
 */
export function calcularTotais(movimentacoes) {
  const entradas = movimentacoes
    .filter(m => m.tipo === 'entrada')
    .reduce((sum, m) => sum + m.valor, 0);

  const saidas = movimentacoes
    .filter(m => m.tipo === 'saida')
    .reduce((sum, m) => sum + m.valor, 0);

  return {
    total_entradas: entradas,
    total_saidas: saidas,
    saldo_periodo: entradas - saidas,
    quantidade_entradas: movimentacoes.filter(m => m.tipo === 'entrada').length,
    quantidade_saidas: movimentacoes.filter(m => m.tipo === 'saida').length
  };
}

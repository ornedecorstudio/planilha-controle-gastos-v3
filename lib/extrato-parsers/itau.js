/**
 * Parser determinístico de extrato Itaú (PDF)
 *
 * Formato do texto extraído por pdf-parse (tudo concatenado sem espaços):
 *   DD/MM/YYYY DESCRIÇÃO [DD/MM] [RAZÃO SOCIAL] CNPJ/CPF VALOR
 *
 * Peculiaridades:
 * - CNPJ/CPF colado no valor: "46.268.741/0001-5911.280,50"
 * - Linhas multi-line: descrição pode continuar em linhas seguintes
 * - Valores negativos = saída, positivos = entrada
 * - "SALDO TOTAL DISPONÍVEL DIA" = linha de saldo (ignorar)
 * - "SALDO ANTERIOR" = ignorar
 * - Rendimentos podem ter valor pequeno sem separador de milhar (ex: "0,25")
 */

// Regex: linha começa com DD/MM/YYYY
const TX_START = /^(\d{2}\/\d{2}\/\d{4})/;

// CNPJ: XX.XXX.XXX/XXXX-XX  (14 dígitos)
const CNPJ_REGEX = /(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})/g;

// CPF: XXX.XXX.XXX-XX  (11 dígitos)
const CPF_REGEX = /(\d{3}\.\d{3}\.\d{3}-\d{2})/g;

// Valor BR no final: -1.300,00 ou 11.280,50 ou 0,25
const VALUE_END = /(-?[\d]+(?:\.[\d]{3})*,\d{2})\s*$/;

// Linhas/blocos a ignorar
const SKIP_PATTERNS = [
  /SALDO TOTAL DISPON[ÍI]VEL/i,
  /SALDO ANTERIOR/i,
  /^Ag[eê]ncia/i,
  /^Saldo total/i,
  /^Limite da conta/i,
  /^Utilizado/i,
  /^Dispon[ií]vel/i,
  /^Lan[çc]amentos do per[ií]odo/i,
  /^Data\s*Lan[çc]amentos/i,
  /^DataLan[çc]amentos/i,
  /^Os saldos acima/i,
  /^novos lan[çc]amentos/i,
  /^atualizado em/i,
  /^Em caso de d[úu]vidas/i,
  /^0800\s/,
  /^SAC\s/i,
  /Raz[aã]o Social/i,
  /CNPJ\/CPF/i,
  /Valor \(R\$\)/i,
  /Saldo \(R\$\)/i,
  /^-?R\$\s/,
];

function parseValorBR(valorStr) {
  const limpo = valorStr.replace(/\./g, '').replace(',', '.').trim();
  return parseFloat(limpo);
}

function isLinhaIgnorar(linha) {
  return SKIP_PATTERNS.some(p => p.test(linha));
}

/**
 * Converte DD/MM/YYYY para YYYY-MM-DD
 */
function formatarData(dataStr) {
  const [dd, mm, yyyy] = dataStr.split('/');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Encontra a ÚLTIMA ocorrência de CNPJ ou CPF no texto e separa:
 * - tudo antes do último CNPJ/CPF → parte da descrição
 * - o CNPJ/CPF em si
 * - tudo depois do CNPJ/CPF → contém o valor monetário
 *
 * Exemplo: "PIX RECEBIDO ORNE DE30/01ORNE DECOR STUDIO LTDA46.268.741/0001-5911.280,50"
 *   → antes: "PIX RECEBIDO ORNE DE30/01ORNE DECOR STUDIO LTDA"
 *   → cnpj:  "46.268.741/0001-59"
 *   → depois: "11.280,50"
 */
function separarCnpjCpfValor(texto) {
  // Encontrar todas as ocorrências de CNPJ e CPF com suas posições
  const matches = [];

  // CNPJ: XX.XXX.XXX/XXXX-XX
  let m;
  const cnpjRe = /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/g;
  while ((m = cnpjRe.exec(texto)) !== null) {
    matches.push({ index: m.index, length: m[0].length, doc: m[0] });
  }

  // CPF: XXX.XXX.XXX-XX
  const cpfRe = /\d{3}\.\d{3}\.\d{3}-\d{2}/g;
  while ((m = cpfRe.exec(texto)) !== null) {
    matches.push({ index: m.index, length: m[0].length, doc: m[0] });
  }

  if (matches.length === 0) {
    return { antes: texto, documento: null, valorTexto: null };
  }

  // Pegar a ÚLTIMA ocorrência (o valor fica depois do último CNPJ/CPF)
  matches.sort((a, b) => b.index - a.index);
  const ultimo = matches[0];

  const antes = texto.substring(0, ultimo.index);
  const depois = texto.substring(ultimo.index + ultimo.length);

  return { antes, documento: ultimo.doc, valorTexto: depois.trim() };
}

/**
 * Determina o tipo (entrada/saida) baseado na descrição da transação.
 *
 * A descrição Itaú inclui tanto o lançamento quanto a razão social do destinatário,
 * então usamos apenas o INÍCIO da descrição (o tipo do lançamento) para classificar.
 * Ex: "PIX RECEBIDO VINDI P VINDI PAGAMENTOS ONLINE" → "PIX RECEBIDO" = entrada
 *     (sem confundir com "PAGAMENTOS" que aparece na razão social)
 */
function determinarTipo(descricao, valor) {
  // Valor negativo é sempre saída
  if (valor < 0) return 'saida';

  const descUpper = descricao.toUpperCase();

  // Palavras-chave de ENTRADA (prioridade alta — checadas primeiro)
  if (/^PIX RECEBIDO/i.test(descUpper)) return 'entrada';
  if (/^PIX QR CODE RECEBIDO/i.test(descUpper)) return 'entrada';
  if (/^PIX DEVOLVIDO/i.test(descUpper)) return 'entrada';
  if (/^TED\b/i.test(descUpper)) return 'entrada';
  if (/^RECEBIMENTO/i.test(descUpper)) return 'entrada';
  if (/^RENDIMENTO/i.test(descUpper)) return 'entrada';
  if (/^CR[EÉ]DITO/i.test(descUpper)) return 'entrada';

  // Palavras-chave de SAÍDA
  if (/^PIX ENVIADO/i.test(descUpper)) return 'saida';
  if (/^PAGAMENTO/i.test(descUpper)) return 'saida';
  if (/^BOLETO PAGO/i.test(descUpper)) return 'saida';
  if (/^PAGAMENTOS/i.test(descUpper)) return 'saida';
  if (/^IOF/i.test(descUpper)) return 'saida';
  if (/^TARIFA/i.test(descUpper)) return 'saida';
  if (/^TAXA/i.test(descUpper)) return 'saida';
  if (/^D[EÉ]BITO/i.test(descUpper)) return 'saida';

  // Fallback: valor positivo = entrada
  return 'entrada';
}

/**
 * Limpa a descrição removendo datas extras (DD/MM) e razão social duplicada
 */
function limparDescricao(descricao) {
  let desc = descricao.trim();

  // Remover datas DD/MM soltas no meio (ex: "PIX RECEBIDO ORNE DE30/01ORNE DECOR...")
  // Padrão: DD/MM seguido de texto (referência de data de crédito)
  // Manter a parte antes e depois
  desc = desc.replace(/(\d{2}\/\d{2})(?=[A-Z])/g, ' ');

  // Limpar espaços múltiplos
  desc = desc.replace(/\s+/g, ' ').trim();

  return desc;
}

/**
 * Parser principal para extrato Itaú
 * @param {string} texto - Texto extraído do PDF por pdf-parse
 * @returns {object} { movimentacoes, banco, periodo_inicio, periodo_fim }
 */
export function parseExtratoItau(texto) {
  const linhas = texto.split('\n');
  const movimentacoes = [];
  let periodoInicio = null;
  let periodoFim = null;

  // Extrair período do cabeçalho: "Lançamentos do período: DD/MM/YYYY até DD/MM/YYYY"
  const periodoMatch = texto.match(/per[ií]odo:\s*(\d{2}\/\d{2}\/\d{4})\s*at[eé]\s*(\d{2}\/\d{2}\/\d{4})/i);
  if (periodoMatch) {
    periodoInicio = formatarData(periodoMatch[1]);
    periodoFim = formatarData(periodoMatch[2]);
  }

  // Acumular linhas multi-line: cada transação começa com uma data
  let currentBlock = null;

  function processarBloco(bloco) {
    if (!bloco) return;

    const textoCompleto = bloco.join(' ').replace(/\s+/g, ' ').trim();

    // Ignorar linhas de saldo e cabeçalho
    if (isLinhaIgnorar(textoCompleto)) return;

    // Extrair data
    const dataMatch = textoCompleto.match(TX_START);
    if (!dataMatch) return;
    const dataStr = dataMatch[1];

    // Remover a data do início para trabalhar com o restante
    const semData = textoCompleto.substring(dataStr.length).trim();

    // Separar: descrição + razão social | CNPJ/CPF | valor
    const { antes, documento, valorTexto } = separarCnpjCpfValor(semData);

    let valor;
    let descricao;

    if (valorTexto !== null && valorTexto !== '') {
      // Caso normal: CNPJ/CPF encontrado, valor está depois dele
      const valorMatch = valorTexto.match(/^(-?[\d]+(?:\.[\d]{3})*,\d{2})/);
      if (!valorMatch) return;
      valor = parseValorBR(valorMatch[1]);
      descricao = antes;
    } else if (documento) {
      // CNPJ/CPF encontrado mas sem valor depois — pode ser bloco incompleto
      return;
    } else {
      // Sem CNPJ/CPF — tentar extrair valor direto do final (ex: rendimentos "0,25")
      const valorMatch = semData.match(VALUE_END);
      if (!valorMatch) return;
      valor = parseValorBR(valorMatch[1]);
      descricao = semData.substring(0, valorMatch.index);
    }

    if (isNaN(valor)) return;
    if (!descricao || !descricao.trim()) return;

    descricao = limparDescricao(descricao);

    // Verificar novamente se é linha de saldo pela descrição
    if (/SALDO TOTAL|SALDO ANTERIOR|SALDO DO DIA/i.test(descricao)) return;

    const tipo = determinarTipo(descricao, valor);
    const dataISO = formatarData(dataStr);

    movimentacoes.push({
      id: `itaupdf_${Date.now()}_${movimentacoes.length}`,
      data: dataISO,
      descricao: descricao.trim(),
      valor: Math.abs(valor),
      tipo,
      documento: documento,
    });
  }

  for (const linha of linhas) {
    const trimmed = linha.trim();
    if (!trimmed) continue;

    // Se a linha começa com data DD/MM/YYYY, é uma nova transação
    if (TX_START.test(trimmed)) {
      // Processar bloco anterior
      processarBloco(currentBlock);
      currentBlock = [trimmed];
    } else if (currentBlock) {
      // Linha de continuação
      currentBlock.push(trimmed);
    }
  }
  // Processar último bloco
  processarBloco(currentBlock);

  console.log(`[extrato-parser:itau] ${movimentacoes.length} movimentações extraídas`);

  return {
    movimentacoes,
    banco: 'Itaú',
    periodo_inicio: periodoInicio,
    periodo_fim: periodoFim,
  };
}

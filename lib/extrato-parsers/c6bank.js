/**
 * Parser determinístico de extrato C6 Bank (PDF)
 *
 * Formato do texto extraído por pdf-parse:
 *   DD/MMDD/MMTipoDescriçãoR$ X.XXX,XX      (entradas)
 *   DD/MMDD/MMTipoDescrição-R$ X.XXX,XX     (saídas)
 *
 * Tipos válidos: "Entradas", "Entrada PIX", "Saída PIX", "Pagamento", "Outros gastos"
 */

const TIPOS_C6 = ['Entrada PIX', 'Entradas', 'Saída PIX', 'Pagamento', 'Outros gastos'];

// Regex: DD/MM DD/MM Tipo Descrição Valor
// Tipo é alternation das categorias C6 (ordem importa: "Entrada PIX" antes de "Entradas")
const TX_REGEX = /^(\d{2}\/\d{2})(\d{2}\/\d{2})(Entrada PIX|Entradas|Saída PIX|Pagamento|Outros gastos)(.+?)([-]?R\$\s*[\d.,]+)\s*$/;

// Linhas a ignorar completamente
const SKIP_PATTERNS = [
  /^Saldo do dia/i,
  /^Data$/,
  /^lançamento$/i,
  /^contábil$/i,
  /^TipoDescriçãoValor$/i,
  /^Extrato exportado/i,
  /^Extrato$/i,
  /^Período/i,
  /^Janeiro|^Fevereiro|^Março|^Abril|^Maio|^Junho|^Julho|^Agosto|^Setembro|^Outubro|^Novembro|^Dezembro/i,
  /^Entradas:\s*R\$/i,
  /^\(/,  // ( 01/01/2026 - 31/01/2026 )
  /^Informações sujeitas/i,
  /^Atendimento/i,
  /^Chat/i,
  /^No app/i,
  /^Capitais/i,
  /^Demais/i,
  /^Whatsapp/i,
  /^Ouvidoria/i,
  /^Segunda/i,
  /^SAC$/i,
  /^Abra uma conta/i,
  /^Baixe o app/i,
  /^\d{4}\s+\d{4}/,  // Números de telefone
  /^0800/,
  /^\(11\)/,
  /^ORNE DECOR/i,
  /^Agência/i,
  /^Saldo do dia/i,
];

function parseValorBR(valorStr) {
  const limpo = valorStr.replace(/R\$\s*/g, '').replace(/\./g, '').replace(',', '.').trim();
  return parseFloat(limpo);
}

/**
 * Extrai período do cabeçalho
 * Formato: "( DD/MM/YYYY - DD/MM/YYYY )"
 */
function extrairPeriodo(texto) {
  const match = texto.match(/\(\s*(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}\/\d{2}\/\d{4})\s*\)/);
  if (match) {
    return { inicio: match[1], fim: match[2] };
  }
  return { inicio: null, fim: null };
}

/**
 * Extrai ano do período para completar datas DD/MM
 */
function extrairAno(texto) {
  const periodo = extrairPeriodo(texto);
  if (periodo.inicio) {
    const parts = periodo.inicio.split('/');
    return parts[2]; // YYYY
  }
  // Fallback: procurar qualquer ano 20XX no texto
  const anoMatch = texto.match(/\b(20\d{2})\b/);
  return anoMatch ? anoMatch[1] : new Date().getFullYear().toString();
}

/**
 * Converte DD/MM + ano para YYYY-MM-DD
 */
function formatarData(ddmm, ano) {
  const [dd, mm] = ddmm.split('/');
  return `${ano}-${mm}-${dd}`;
}

/**
 * Determina tipo da movimentação (entrada/saida) baseado no tipo C6 e valor
 */
function determinarTipo(tipoC6, valorStr) {
  if (valorStr.startsWith('-')) return 'saida';
  if (tipoC6 === 'Saída PIX' || tipoC6 === 'Pagamento' || tipoC6 === 'Outros gastos') return 'saida';
  return 'entrada';
}

/**
 * Parser principal para extrato C6 Bank
 * @param {string} texto - Texto extraído do PDF por pdf-parse
 * @returns {object} { movimentacoes, banco, periodo_inicio, periodo_fim }
 */
export function parseExtratoC6Bank(texto) {
  const linhas = texto.split('\n');
  const ano = extrairAno(texto);
  const periodo = extrairPeriodo(texto);
  const movimentacoes = [];

  for (const linha of linhas) {
    const trimmed = linha.trim();
    if (!trimmed) continue;

    // Pular linhas de cabeçalho/rodapé
    if (SKIP_PATTERNS.some(p => p.test(trimmed))) continue;

    // Tentar match de transação
    const match = trimmed.match(TX_REGEX);
    if (!match) continue;

    const [, dataLanc, , tipoC6, descricao, valorStr] = match;
    const valor = parseValorBR(valorStr);
    if (isNaN(valor) || valor === 0) continue;

    const tipo = determinarTipo(tipoC6, valorStr.trim());
    const dataISO = formatarData(dataLanc, ano);

    movimentacoes.push({
      id: `c6pdf_${Date.now()}_${movimentacoes.length}`,
      data: dataISO,
      descricao: descricao.trim(),
      valor: Math.abs(valor),
      tipo,
      documento: null,
    });
  }

  // Converter datas do período para ISO
  let periodoInicio = null;
  let periodoFim = null;
  if (periodo.inicio) {
    const [d, m, y] = periodo.inicio.split('/');
    periodoInicio = `${y}-${m}-${d}`;
  }
  if (periodo.fim) {
    const [d, m, y] = periodo.fim.split('/');
    periodoFim = `${y}-${m}-${d}`;
  }

  console.log(`[extrato-parser:c6bank] ${movimentacoes.length} movimentações extraídas`);

  return {
    movimentacoes,
    banco: 'C6 Bank',
    periodo_inicio: periodoInicio,
    periodo_fim: periodoFim,
  };
}

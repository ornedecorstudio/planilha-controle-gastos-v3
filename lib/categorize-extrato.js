/**
 * Categorizador de Movimentações de Extrato Bancário PJ
 * Baseado no Contrato de Reembolso ORNE Decor Studio
 *
 * CONTEXTO:
 * - Conta PJ da ORNE DECOR STUDIO LTDA (CNPJ: 46.268.741/0001-59)
 * - Sócio: Erick Beserra de Souza (CPF: 702.642.624-92)
 * - PJ reembolsa PF pelos gastos empresariais feitos nos cartões pessoais
 */

// Cores para cada categoria (Tailwind CSS)
export const CATEGORIA_EXTRATO_COLORS = {
  'Reembolso Sócio': 'bg-amber-100 text-amber-800',
  'Aporte Sócio': 'bg-emerald-100 text-emerald-800',
  'Fretes': 'bg-blue-100 text-blue-800',
  'Impostos': 'bg-red-100 text-red-800',
  'Contabilidade': 'bg-purple-100 text-purple-800',
  'Câmbio': 'bg-green-100 text-green-800',
  'Taxas/Checkout': 'bg-yellow-100 text-yellow-800',
  'Receitas': 'bg-teal-100 text-teal-800',
  'Transferência Interna': 'bg-slate-100 text-slate-800',
  'Funcionários': 'bg-indigo-100 text-indigo-800',
  'Rendimentos': 'bg-cyan-100 text-cyan-800',
  'Pagamentos': 'bg-orange-100 text-orange-800',
  'Outros': 'bg-gray-100 text-gray-800',
};

// Lista de categorias disponíveis
export const CATEGORIAS_EXTRATO = [
  'Reembolso Sócio',
  'Aporte Sócio',
  'Fretes',
  'Impostos',
  'Contabilidade',
  'Câmbio',
  'Taxas/Checkout',
  'Receitas',
  'Transferência Interna',
  'Funcionários',
  'Rendimentos',
  'Pagamentos',
  'Outros',
];

/**
 * Categoriza uma movimentação do extrato bancário
 * @param {string} descricao - Descrição/MEMO da transação
 * @param {string} tipo - 'entrada' ou 'saida'
 * @param {number} valor - Valor da transação
 * @returns {object} { categoria, subcategoria, isReembolso }
 */
export function categorizeMovimentacao(descricao, tipo, valor = 0) {
  const desc = (descricao || '').toUpperCase();

  // ===== REEMBOLSOS AO SÓCIO (SAÍDA DA PJ PARA PF) =====
  // PIX enviados para Erick = Reembolso de despesas dos cartões PF
  if (desc.includes('ERICK BESERRA') && tipo === 'saida') {
    return {
      categoria: 'Reembolso Sócio',
      subcategoria: 'Cartão PF',
      isReembolso: true,
      prioridade: 1
    };
  }

  // ===== APORTES DO SÓCIO (ENTRADA NA PJ) =====
  // PIX/TED recebidos de Erick = Aporte de capital ou devolução
  if (desc.includes('ERICK BESERRA') && tipo === 'entrada') {
    // Verificar se é devolução de PIX
    if (desc.includes('DEVOLVIDO') || desc.includes('DEVOLUCAO')) {
      return {
        categoria: 'Aporte Sócio',
        subcategoria: 'Devolução PIX',
        isReembolso: false,
        prioridade: 1
      };
    }
    return {
      categoria: 'Aporte Sócio',
      subcategoria: 'Capital/Empréstimo',
      isReembolso: false,
      prioridade: 1
    };
  }

  // ===== RECEITAS - VENDAS ONLINE (PRIORIDADE ALTA) =====
  // Colocado antes de Impostos para evitar conflito com "RECEBIMENTOS"
  if (desc.match(/RECEBIMENTOS.*APPMAX|APPMAX.*PLATAFORMA|VINDI|YAMPI|CARTPANDA|HOTMART|EDUZZ|KIWIFY|MONETIZZE/i) && tipo === 'entrada') {
    return {
      categoria: 'Receitas',
      subcategoria: 'Vendas Online',
      isReembolso: false,
      prioridade: 1
    };
  }

  // ===== LOGÍSTICA E FULFILLMENT =====
  if (desc.match(/ROGER FULFILLMENT|FULFILLMENT/i)) {
    return {
      categoria: 'Fretes',
      subcategoria: 'Fulfillment',
      isReembolso: false,
      prioridade: 2
    };
  }

  if (desc.match(/CORREIOS|ECT|SEDEX|PAC/i)) {
    return {
      categoria: 'Fretes',
      subcategoria: 'Correios',
      isReembolso: false,
      prioridade: 2
    };
  }

  if (desc.match(/JADLOG|TOTAL EXPRESS|AZUL CARGO|LOGGI|LOGGI TECNOLOGIA|MELHOR ENVIO/i)) {
    return {
      categoria: 'Fretes',
      subcategoria: 'Transportadora',
      isReembolso: false,
      prioridade: 2
    };
  }

  // ===== PICPAY - Pagamentos a Fornecedores =====
  if (desc.match(/PICPAY\*ORNE|PICPAY.*ORNE DECOR/i) && tipo === 'saida') {
    return {
      categoria: 'Pagamentos',
      subcategoria: 'Fornecedor via PicPay',
      isReembolso: false,
      prioridade: 2
    };
  }

  // ===== IMPOSTOS E TRIBUTOS =====
  if (desc.match(/RECEITA FEDERAL|DARF|DAS|GPS|SIMPLES|FGTS|INSS/i)) {
    return {
      categoria: 'Impostos',
      subcategoria: 'Federal',
      isReembolso: false,
      prioridade: 2
    };
  }

  if (desc.match(/IPTU|ISS|ICMS|IPVA|DETRAN/i)) {
    return {
      categoria: 'Impostos',
      subcategoria: 'Estadual/Municipal',
      isReembolso: false,
      prioridade: 2
    };
  }

  if (desc.match(/TRIB.*COD.*BARRAS|PAGAMENTOS.*TRIB/i)) {
    return {
      categoria: 'Impostos',
      subcategoria: 'Guia/Boleto',
      isReembolso: false,
      prioridade: 2
    };
  }

  // ===== CONTABILIDADE =====
  if (desc.match(/REGENCIA.*CONTAB|CONTABIL|CONTADOR|ESCRITORIO/i)) {
    return {
      categoria: 'Contabilidade',
      subcategoria: 'Honorários',
      isReembolso: false,
      prioridade: 2
    };
  }

  // ===== CÂMBIO E PAGAMENTOS INTERNACIONAIS =====
  if (desc.match(/DLOCAL|WISE|TRANSFERWISE|REMESSA|CAMBIO/i)) {
    return {
      categoria: 'Câmbio',
      subcategoria: 'Compra Dólar',
      isReembolso: false,
      prioridade: 2
    };
  }

  // ===== TAXAS E CHECKOUT =====
  if (desc.match(/PAGAR\.ME|PAGARME|MERCADO PAGO|MP \*|PAGSEGURO/i) && tipo === 'saida') {
    return {
      categoria: 'Taxas/Checkout',
      subcategoria: 'Gateway Pagamento',
      isReembolso: false,
      prioridade: 2
    };
  }

  if (desc.match(/VINDI|YAMPI|CARTPANDA|STRIPE/i) && tipo === 'saida') {
    return {
      categoria: 'Taxas/Checkout',
      subcategoria: 'Plataforma',
      isReembolso: false,
      prioridade: 2
    };
  }

  // ===== RECEITAS - VENDAS ONLINE (regra secundária) =====
  // A regra principal está no início do código para ter prioridade sobre Impostos
  if (desc.match(/APPMAX|VINDI|YAMPI|CARTPANDA|HOTMART|EDUZZ|KIWIFY|MONETIZZE/i) && tipo === 'entrada') {
    return {
      categoria: 'Receitas',
      subcategoria: 'Vendas Online',
      isReembolso: false,
      prioridade: 2
    };
  }

  // ===== RECEITAS - CLIENTES DIRETOS =====
  if (desc.match(/RECEBIDO.*MARIA|RECEBIDO.*CLIENTE/i) && tipo === 'entrada') {
    return {
      categoria: 'Receitas',
      subcategoria: 'Cliente Direto',
      isReembolso: false,
      prioridade: 3
    };
  }

  // ===== TRANSFERÊNCIAS INTERNAS (ENTRE CONTAS ORNE) =====
  if (desc.match(/ORNE DECOR|ORNE DE\d{2}/i) && tipo === 'entrada') {
    return {
      categoria: 'Transferência Interna',
      subcategoria: 'Entre Contas',
      isReembolso: false,
      prioridade: 2
    };
  }

  if (desc.match(/ORNE|46\.268\.741/i) && tipo === 'saida') {
    return {
      categoria: 'Transferência Interna',
      subcategoria: 'Entre Contas',
      isReembolso: false,
      prioridade: 2
    };
  }

  // ===== FORNECEDORES IDENTIFICADOS =====
  if (desc.match(/ABAZZUR/i) && tipo === 'entrada') {
    return {
      categoria: 'Receitas',
      subcategoria: 'Parceiro/Revenda',
      isReembolso: false,
      prioridade: 3
    };
  }

  // ===== FUNCIONÁRIOS E PRESTADORES =====
  if (desc.match(/LEONARDO MOURA|ELISANGELA|CLAUDIO ROGERIO/i) && tipo === 'saida') {
    return {
      categoria: 'Funcionários',
      subcategoria: 'Prestador de Serviço',
      isReembolso: false,
      prioridade: 3
    };
  }

  if (desc.match(/SALARIO|FOLHA|CLT|FERIAS|13.*SALARIO|DECIMO/i)) {
    return {
      categoria: 'Funcionários',
      subcategoria: 'Salário/Benefícios',
      isReembolso: false,
      prioridade: 2
    };
  }

  // ===== RENDIMENTOS =====
  if (desc.match(/RENDIMENTO|REND.*PAGO|APLIC.*AUT|CDB|LCI|LCA/i)) {
    return {
      categoria: 'Rendimentos',
      subcategoria: 'Aplicação',
      isReembolso: false,
      prioridade: 3
    };
  }

  // ===== PAYPAL =====
  if (desc.match(/PAYPAL/i)) {
    if (tipo === 'entrada') {
      return {
        categoria: 'Receitas',
        subcategoria: 'PayPal',
        isReembolso: false,
        prioridade: 3
      };
    }
    return {
      categoria: 'Câmbio',
      subcategoria: 'PayPal',
      isReembolso: false,
      prioridade: 3
    };
  }

  // ===== BOLETOS GENÉRICOS =====
  if (desc.match(/BOLETO.*PAGO|PAGTO.*BOLETO/i) && tipo === 'saida') {
    return {
      categoria: 'Pagamentos',
      subcategoria: 'Boleto',
      isReembolso: false,
      prioridade: 4
    };
  }

  // ===== PIX GENÉRICOS =====
  if (desc.match(/PIX.*ENVIADO|PIX.*QR.*CODE/i) && tipo === 'saida') {
    return {
      categoria: 'Pagamentos',
      subcategoria: 'PIX',
      isReembolso: false,
      prioridade: 4
    };
  }

  if (desc.match(/PIX.*RECEBIDO|PIX.*QR.*CODE.*RECEBIDO/i) && tipo === 'entrada') {
    return {
      categoria: 'Receitas',
      subcategoria: 'PIX',
      isReembolso: false,
      prioridade: 4
    };
  }

  // ===== DEFAULT =====
  return {
    categoria: tipo === 'entrada' ? 'Receitas' : 'Pagamentos',
    subcategoria: 'Outros',
    isReembolso: false,
    prioridade: 5
  };
}

/**
 * Categoriza um array de movimentações
 * @param {array} movimentacoes - Lista de movimentações do parser OFX
 * @returns {array} Movimentações com categoria adicionada
 */
export function categorizeAll(movimentacoes) {
  return movimentacoes.map(mov => {
    const categorizacao = categorizeMovimentacao(mov.descricao, mov.tipo, mov.valor);
    return {
      ...mov,
      categoria: categorizacao.categoria,
      subcategoria: categorizacao.subcategoria,
      isReembolso: categorizacao.isReembolso
    };
  });
}

/**
 * Calcula resumo por categoria
 * @param {array} movimentacoes - Lista de movimentações categorizadas
 * @returns {object} Resumo por categoria
 */
export function calcularResumoPorCategoria(movimentacoes) {
  const resumo = {};

  movimentacoes.forEach(mov => {
    const cat = mov.categoria || 'Outros';
    if (!resumo[cat]) {
      resumo[cat] = {
        categoria: cat,
        total: 0,
        quantidade: 0,
        tipo: mov.tipo
      };
    }
    resumo[cat].total += mov.valor;
    resumo[cat].quantidade += 1;
  });

  return Object.values(resumo).sort((a, b) => b.total - a.total);
}

/**
 * Identifica potenciais reembolsos para vincular com faturas
 * @param {array} movimentacoes - Lista de movimentações
 * @returns {array} Lista de reembolsos identificados
 */
export function identificarReembolsos(movimentacoes) {
  return movimentacoes
    .filter(mov => mov.isReembolso === true)
    .map(mov => ({
      id: mov.id,
      data: mov.data,
      valor: mov.valor,
      descricao: mov.descricao,
      documento: mov.documento
    }));
}

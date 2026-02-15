import { NextResponse } from 'next/server';
import { categorizarML } from '@/lib/ml/categorizer';

// ============================================================
// CATEGORIZACAO DETERMINISTICA AMPLIADA
// Regras fixas do negocio: AliExpress = SEMPRE PJ
// ============================================================

function categorizarDeterministico(descricao) {
  const desc = descricao.toUpperCase().trim();

  // ===== ESTORNOS E CRÉDITOS — VERIFICAR ANTES DE TUDO =====
  // Precisa rodar antes das regras de AliExpress/fornecedores para que
  // "ALIEXPRESS - Estorno" seja classificado como Estorno, nao como Fornecedor.
  if (desc.includes('ESTORNO') || desc.includes('CREDITO NA FATURA') || desc.includes('CREDITO FATURA') ||
      desc.includes('DEVOLUCAO') || desc.includes('REEMBOLSO') || desc.includes('CASHBACK') || desc.includes('BONIFICACAO')) {
    return { categoria: 'Estorno', incluir: false, confianca: 'alta' };
  }

  // ===== PAGAMENTO ANTECIPADO — VERIFICAR ANTES DE FORNECEDORES =====
  if (desc.includes('PAGAMENTO ANTECIPADO') || desc.includes('PGTO ANTECIPADO') || desc.includes('PAG ANTECIPADO')) {
    return { categoria: 'Pagamento Fatura', incluir: false, confianca: 'alta' };
  }

  // ===== REGRA FIXA: AliExpress = SEMPRE Pagamento Fornecedores =====
  // Usuario confirmou que NUNCA compra pessoal no AliExpress
  if (desc.includes('ALIEXPRESS') || desc.includes('ALIPAY') || desc.includes('ALIBABA') || desc.includes('ALI EXPRESS')) {
    return { categoria: 'Pagamento Fornecedores', incluir: true, confianca: 'alta' };
  }
  if (desc.startsWith('DL*ALIEXPRESS') || desc.includes('DL*ALI')) {
    return { categoria: 'Pagamento Fornecedores', incluir: true, confianca: 'alta' };
  }
  if (desc.includes('PAYPAL') && desc.includes('ALIPAY')) {
    return { categoria: 'Pagamento Fornecedores', incluir: true, confianca: 'alta' };
  }

  // ===== MARKETING DIGITAL (PJ) =====
  if (desc.match(/PAYPAL\*PAYPAL\s*\*FA/)) {
    return { categoria: 'Marketing Digital', incluir: true, confianca: 'alta' };
  }
  if (desc.includes('FACEBK') || desc.includes('FACEBOOK') || desc.startsWith('FB ') || desc.includes('META ADS')) {
    return { categoria: 'Marketing Digital', incluir: true, confianca: 'alta' };
  }
  if (desc.includes('PAYPAL') && (desc.includes('FACEBOOK') || desc.includes('FACEB') || desc.includes('FACEBOOKSER'))) {
    return { categoria: 'Marketing Digital', incluir: true, confianca: 'alta' };
  }
  if (desc.includes('GOOGLE ADS') || desc.includes('GOOGLE AD') || desc.includes('ADWORDS')) {
    return { categoria: 'Marketing Digital', incluir: true, confianca: 'alta' };
  }
  if (desc.includes('MICROSOFT') && (desc.includes('ADS') || desc.includes('ADVERTISING'))) {
    return { categoria: 'Marketing Digital', incluir: true, confianca: 'alta' };
  }
  const marketingTermos = ['HUBSPOT', 'MAILCHIMP', 'SEMRUSH', 'TABOOLA', 'OUTBRAIN', 'LINKEDIN ADS', 'PINTEREST ADS'];
  for (const termo of marketingTermos) {
    if (desc.includes(termo)) return { categoria: 'Marketing Digital', incluir: true, confianca: 'alta' };
  }
  // TikTok e Kwai - podem ser ads ou pessoal, mas como empresa de e-commerce, geralmente sao ads
  if (desc.includes('TIKTOK') && (desc.includes('ADS') || desc.includes('ADVERT'))) {
    return { categoria: 'Marketing Digital', incluir: true, confianca: 'alta' };
  }
  if (desc.includes('KWAI') && (desc.includes('ADS') || desc.includes('ADVERT'))) {
    return { categoria: 'Marketing Digital', incluir: true, confianca: 'alta' };
  }

  // ===== TAXAS CHECKOUT (PJ) =====
  const checkoutTermos = [
    'YAMPI', 'CARTPANDA', 'BRCARTPANDA', 'SHOPIFY', 'NUVEMSHOP',
    'APPMAX', 'VINDI', 'PAGBR', 'HOTMART', 'EDUZZ', 'MONETIZZE',
    'STRIPE', 'PAGARME', 'MUNDIPAGG', 'CIELO', 'GETNET', 'STONE'
  ];
  for (const termo of checkoutTermos) {
    if (desc.includes(termo)) return { categoria: 'Taxas Checkout', incluir: true, confianca: 'alta' };
  }
  if (desc.includes('PG *YAMPI') || desc.includes('PG*YAMPI')) {
    return { categoria: 'Taxas Checkout', incluir: true, confianca: 'alta' };
  }

  // ===== ERP (PJ) =====
  const erpTermos = ['TINY', 'BLING', 'OMIE', 'CONTA AZUL', 'OLIST'];
  for (const termo of erpTermos) {
    if (desc.includes(termo)) return { categoria: 'ERP', incluir: true, confianca: 'alta' };
  }

  // ===== DESIGN/FERRAMENTAS (PJ) =====
  const designTermos = [
    'CANVA', 'ADOBE', 'FIGMA', 'SKETCH', 'FREEPIK', 'MAGNIFIC',
    'ENVATO', 'SHUTTERSTOCK', 'ISTOCK', 'UNSPLASH',
    'VERCEL', 'NETLIFY', 'HEROKU', 'DIGITAL OCEAN', 'HOSTINGER',
    'GITHUB', 'GITLAB', 'BITBUCKET', 'JETBRAINS'
  ];
  for (const termo of designTermos) {
    if (desc.includes(termo)) return { categoria: 'Design/Ferramentas', incluir: true, confianca: 'alta' };
  }

  // ===== IA E AUTOMACAO (PJ) =====
  const iaTermos = [
    'OPENAI', 'CHATGPT', 'CLAUDE', 'ANTHROPIC',
    'AWS', 'AMAZON WEB', 'GOOGLE CLOUD', 'GCP', 'AZURE',
    'MAKE.COM', 'ZAPIER', 'N8N', 'INTEGROMAT'
  ];
  for (const termo of iaTermos) {
    if (desc.includes(termo)) return { categoria: 'IA e Automacao', incluir: true, confianca: 'alta' };
  }

  // ===== TELEFONIA (PJ) =====
  const telefoniaTermos = ['BRDID', 'VOIP', 'TWILIO', 'ZENVIA'];
  for (const termo of telefoniaTermos) {
    if (desc.includes(termo)) return { categoria: 'Telefonia', incluir: true, confianca: 'alta' };
  }

  // ===== GESTAO (PJ) =====
  const gestaoTermos = [
    'TRELLO', 'ATLASSIAN', 'NOTION', 'ASANA', 'MONDAY',
    'ZOOM', 'SLACK', 'CLICKUP', 'BASECAMP', 'JIRA'
  ];
  for (const termo of gestaoTermos) {
    if (desc.includes(termo)) return { categoria: 'Gestao', incluir: true, confianca: 'alta' };
  }

  // ===== FRETES (PJ) =====
  // Transportadoras e serviços de envio/logística
  const fretesTermos = [
    'LOGGI', 'CORREIOS', 'JADLOG', 'SEQUOIA', 'TOTAL EXPRESS',
    'MELHOR ENVIO', 'KANGU', 'MANDAE', 'AZUL CARGO'
  ];
  for (const termo of fretesTermos) {
    if (desc.includes(termo)) return { categoria: 'Fretes', incluir: true, confianca: 'alta' };
  }

  // ===== PICPAY - Pagamentos a Fornecedores (PJ) =====
  // PICPAY*ORNE = pagamentos para a própria empresa ou fornecedores
  if (desc.startsWith('PICPAY*ORNE') || desc.includes('PICPAY*ORNE DECOR')) {
    return { categoria: 'Pagamento Fornecedores', incluir: true, confianca: 'alta' };
  }
  // PICPAY* genérico em cartão PJ = geralmente pagamento a fornecedores
  if (desc.startsWith('PICPAY*') && !desc.includes('PICPAY*NETFLIX') && !desc.includes('PICPAY*SPOTIFY') && !desc.includes('PICPAY*IFOOD')) {
    return { categoria: 'Pagamento Fornecedores', incluir: true, confianca: 'media' };
  }

  // ===== PAGAMENTO FORNECEDORES (PJ) =====
  const fornecedoresTermos = [
    'ROGER FULFILLMENT'
  ];
  for (const termo of fornecedoresTermos) {
    if (desc.includes(termo)) return { categoria: 'Pagamento Fornecedores', incluir: true, confianca: 'alta' };
  }

  // ===== PAGAMENTO DE FATURA =====
  // "Pagamento da fatura de dezembro/2025" (Mercado Pago) → Pagamento Fatura
  // Outros pagamentos genéricos de fatura → Pessoal
  if (desc.includes('PAGAMENTO') && desc.includes('FATURA')) {
    if (desc.includes('PAGAMENTO DA FATURA DE')) {
      return { categoria: 'Pagamento Fatura', incluir: false, confianca: 'alta' };
    }
    return { categoria: 'Pessoal', incluir: false, confianca: 'alta' };
  }
  if (desc === 'PAGAMENTO DE FATURA' || desc.startsWith('PAGAMENTO DE FATURA') || desc.startsWith('PAGAMENTO FATURA')) {
    return { categoria: 'Pessoal', incluir: false, confianca: 'alta' };
  }
  if (desc.includes('PAGAMENTO RECEBIDO') || desc.includes('INCLUSAO DE PAGAMENTO')) {
    return { categoria: 'Outros', incluir: false, confianca: 'alta' };
  }
  if (desc.includes('FATURA SEGURA') || desc.includes('SEGURO FATURA')) {
    return { categoria: 'Tarifas Cartão', incluir: false, confianca: 'alta' };
  }
  if (desc.includes('ANUIDADE')) {
    return { categoria: 'Tarifas Cartão', incluir: false, confianca: 'alta' };
  }
  if (desc.includes('AVAL EMERG') || desc.includes('AVALIACAO EMERG') || desc.includes('CREDITO EMERG')) {
    return { categoria: 'Tarifas Cartão', incluir: false, confianca: 'alta' };
  }
  if (desc.includes('SEG CONTA') || desc.includes('SEGURO CONTA')) {
    return { categoria: 'Tarifas Cartão', incluir: false, confianca: 'alta' };
  }
  if (desc.includes('TARIFA')) {
    return { categoria: 'Tarifas Cartão', incluir: false, confianca: 'alta' };
  }
  if (desc.includes('ENCARGO') || desc.includes('MULTA') || desc.includes('JUROS MORA')) {
    return { categoria: 'Pessoal', incluir: false, confianca: 'alta' };
  }

  // (Estornos e pagamento antecipado ja verificados no topo da funcao)

  // ===== IOF - gasto PJ (imposto sobre operações financeiras) =====
  if (desc.includes('IOF') || desc.includes('IMPOSTO OPERACOES FINANCEIRAS')) {
    return { categoria: 'IOF', incluir: true, confianca: 'alta' };
  }

  // ===== ALIMENTACAO (PF) =====
  const alimentacaoTermos = [
    'SUSHI', 'BURGER', 'PIZZA', 'MCDONALDS', 'MCDONALD', 'SUBWAY',
    'HABIB', 'OUTBACK', 'RESTAURANTE', 'LANCHONETE', 'PADARIA',
    'CAFETERIA', 'STARBUCKS', 'IFOOD', 'RAPPI',
    'SMASH', 'CHURRASCARIA', 'ACAI', 'SORVETERIA', 'BOBS',
    'KFC', 'POPEYES', 'MADERO', 'COCO BAMBU', 'SPOLETO',
    'GIRAFFAS', 'CHINA IN BOX', 'DOMINOS', 'PIZZA HUT',
    'BURGER KING', 'JERONIMO', 'VIVENDA DO CAMARAO'
  ];
  for (const termo of alimentacaoTermos) {
    if (desc.includes(termo)) return { categoria: 'Pessoal', incluir: false, confianca: 'alta' };
  }
  // iFood com prefixo IFD*
  if (desc.startsWith('IFD*') || desc.includes('IFD*')) {
    return { categoria: 'Pessoal', incluir: false, confianca: 'alta' };
  }

  // ===== SAUDE E FARMACIA (PF) =====
  const saudeTermos = [
    'FARMACIA', 'DROGASIL', 'DROGARIA', 'REDEPHARMA', 'PACHECO',
    'PANVEL', 'DROGA RAIA', 'DROGARAIA', 'PAGUE MENOS',
    'ULTRAFARMA', 'DROGASARAUJO', 'EXTRAFARMA',
    'HOSPITAL', 'CLINICA', 'LABORATORIO', 'UNIMED', 'AMIL',
    'HAPVIDA', 'ODONTO', 'DENTISTA', 'OTICA'
  ];
  for (const termo of saudeTermos) {
    if (desc.includes(termo)) return { categoria: 'Pessoal', incluir: false, confianca: 'alta' };
  }

  // ===== MODA E VESTUARIO (PF) =====
  const modaTermos = [
    'RAYBAN', 'RAY-BAN', 'RENNER', 'C&A', 'CEA', 'ZARA',
    'NIKE', 'ADIDAS', 'CENTAURO', 'NETSHOES', 'RIACHUELO',
    'HERING', 'MARISA', 'PERNAMBUCANAS', 'LUPO', 'RESERVA',
    'OSKLEN', 'HAVAIANAS', 'MELISSA', 'AREZZO', 'SCHUTZ',
    'SHEIN', 'TEMU'
  ];
  for (const termo of modaTermos) {
    if (desc.includes(termo)) return { categoria: 'Pessoal', incluir: false, confianca: 'alta' };
  }

  // ===== SUPERMERCADO E CASA (PF) =====
  const superTermos = [
    'CARREFOUR', 'EXTRA', 'PAO DE ACUCAR', 'ASSAI', 'ATACADAO',
    'BIG', 'SUPERMERCADO', 'SAM S CLUB', 'SAMS CLUB',
    'NATURAL DA TERRA', 'HORTIFRUTI', 'HORTIFRUIT',
    'FERREIRA COSTA', 'LEROY MERLIN', 'TELHA NORTE', 'CASA SHOW',
    'TOKSTOK', 'ETNA', 'CAMICADO', 'DPASCHOAL', 'PNEUMAC'
  ];
  for (const termo of superTermos) {
    if (desc.includes(termo)) return { categoria: 'Pessoal', incluir: false, confianca: 'alta' };
  }

  // ===== TRANSPORTE PESSOAL (PF) =====
  const transporteTermos = [
    'UBER', '99POP', '99APP', 'CABIFY', 'TAXI',
    'SHELL', 'IPIRANGA', 'POSTO', 'PETROBRAS', 'GASOLINA',
    'COMBUSTIVEL', 'AUTO POSTO', 'BR DISTRIBUIDORA',
    'PARKING', 'ESTACIONAMENTO', 'LAZ PARKING', 'ESTAPAR',
    'ZONA AZUL', 'AGILPARK', 'INDIGO PARK'
  ];
  for (const termo of transporteTermos) {
    if (desc.includes(termo)) return { categoria: 'Pessoal', incluir: false, confianca: 'alta' };
  }
  // 99 com espaco (para nao confundir com numeros)
  if (desc.match(/\b99\s/)) {
    return { categoria: 'Pessoal', incluir: false, confianca: 'media' };
  }

  // ===== VIAGENS PESSOAIS (PF) =====
  const viagensTermos = [
    'GOL', 'LATAM', 'AZUL', 'AVIANCA', 'TAM',
    'AMERICAN AIRLINES', 'UNITED', 'DELTA',
    'SMILES', 'MULTIPLUS', 'LIVELO', 'TUDOAZUL',
    'PASSAGEM', 'PASSAGENS', 'AEREO', 'AEREA', 'AIRLINE', 'AIRLINES',
    'MAXMILHAS', 'VOEAZUL', 'VOEGOL', 'VOELATAM', '123MILHAS',
    'HOTEIS.COM', 'HOTEIS', 'BOOKING', 'AIRBNB', 'DECOLAR',
    'TRIVAGO', 'EXPEDIA', 'HOTEL', 'POUSADA', 'HOSPEDAGEM',
    'RENT A CAR', 'LOCALIZA', 'MOVIDA', 'UNIDAS'
  ];
  for (const termo of viagensTermos) {
    if (desc.includes(termo)) return { categoria: 'Pessoal', incluir: false, confianca: 'alta' };
  }

  // ===== ENTRETENIMENTO E STREAMING (PF) =====
  const entretenimentoTermos = [
    'NETFLIX', 'SPOTIFY', 'DISNEY', 'HBO', 'AMAZON PRIME',
    'DEEZER', 'YOUTUBE PREMIUM', 'GLOBOPLAY', 'TELECINE',
    'PARAMOUNT', 'APPLE TV', 'CRUNCHYROLL', 'STAR PLUS',
    'PLAYSTATION', 'SONY PLAYSTATION', 'SONYPLAYSTAT',
    'XBOX', 'STEAM', 'NINTENDO',
    'CINEMA', 'INGRESSO', 'TEATRO', 'MUSEUM', 'MUSEU',
    'GIFT CARD', 'GIFTCARD'
  ];
  for (const termo of entretenimentoTermos) {
    if (desc.includes(termo)) return { categoria: 'Pessoal', incluir: false, confianca: 'alta' };
  }
  // EBN*SONYPLAYSTAT (formato de fatura)
  if (desc.startsWith('EBN*') && desc.includes('SONY')) {
    return { categoria: 'Pessoal', incluir: false, confianca: 'alta' };
  }
  // Apple
  if (desc.includes('APPLE.COM/BILL') || desc.includes('APPLE.COM') || desc.includes('ITUNES')) {
    return { categoria: 'Pessoal', incluir: false, confianca: 'alta' };
  }

  // ===== LOJAS E COMPRAS PESSOAIS (PF) =====
  const lojasTermos = [
    'DAFONTE', 'CASAS BAHIA', 'MAGAZINE LUIZA', 'MAGALU',
    'AMERICANAS', 'PONTO FRIO', 'SHOPEE', 'MERCADOLIVRE',
    'MERCADO LIVRE', 'MELI', 'AMAZON.COM.BR',
    'KABUM', 'PICHAU', 'TERABYTE', 'FAST SHOP'
  ];
  for (const termo of lojasTermos) {
    if (desc.includes(termo)) return { categoria: 'Pessoal', incluir: false, confianca: 'alta' };
  }

  // ===== SERVICOS PESSOAIS (PF) =====
  if (desc.includes('SERASA') || desc.includes('EXPERIAN')) {
    return { categoria: 'Pessoal', incluir: false, confianca: 'alta' };
  }

  // ===== REGRAS DE PADRAO (PF - confianca media) =====

  // Nomes de pessoas (transferencias) = PESSOAL
  if (/^[A-Z]+ [A-Z]+ ?[A-Z]?$/.test(desc) || desc.includes('NORMA')) {
    return { categoria: 'Pessoal', incluir: false, confianca: 'media' };
  }

  // PIX transferencias pessoais
  if (desc.startsWith('PIX ') || desc.includes('PIX ENVIADO') || desc.includes('PIX RECEBIDO')) {
    return { categoria: 'Pessoal', incluir: false, confianca: 'media' };
  }

  // MP* = Mercado Pago (geralmente pessoal)
  if (desc.startsWith('MP*') || desc.startsWith('MP *')) {
    // Exceto se for ferramenta empresarial conhecida
    if (!desc.includes('TINY') && !desc.includes('YAMPI') && !desc.includes('CANVA')) {
      return { categoria: 'Pessoal', incluir: false, confianca: 'media' };
    }
  }

  // EC* = PagSeguro/Ecommerce
  if (desc.startsWith('EC *') || desc.startsWith('EC*')) {
    return { categoria: 'Pessoal', incluir: false, confianca: 'media' };
  }

  // PAG* = PagSeguro transferencias
  if (desc.startsWith('PAG*') && !desc.includes('PAGSEGURO')) {
    return { categoria: 'Pessoal', incluir: false, confianca: 'media' };
  }

  // MERCADO com contexto ambiguo (pode ser supermercado ou Mercado Livre)
  if (desc.includes('MERCADO') && !desc.includes('MERCADO PAGO') && !desc.includes('MERCADOLIVRE') && !desc.includes('MERCADO LIVRE')) {
    return { categoria: 'Pessoal', incluir: false, confianca: 'media' };
  }

  // ===== CASO NAO IDENTIFICADO = envia para IA =====
  return { categoria: null, incluir: null, confianca: 'baixa' };
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { transacoes, tipo_cartao } = body;

    if (!transacoes || transacoes.length === 0) {
      return NextResponse.json({ error: 'Nenhuma transacao fornecida' }, { status: 400 });
    }

    // ===== PASSO 1: Categorizacao deterministica =====
    const resultados = [];
    const duvidosos = [];

    for (let i = 0; i < transacoes.length; i++) {
      const t = transacoes[i];

      // ===== MERCHANT OVERRIDE =====
      // Descrições de merchants conhecidos NUNCA devem ser sobrescritas por tipo_lancamento da IA.
      // Ex: ALIEXPRESS.COM com tipo_lancamento 'pagamento_fatura' (erro da IA) deve ser 'Pagamento Fornecedores'.
      // Preserva IOF e Estorno legítimos (IOF de compra internacional, estorno de AliExpress).
      const descUpper = (t.descricao || '').toUpperCase().trim();
      const isMerchantConhecido = (
        descUpper.includes('ALIEXPRESS') || descUpper.includes('ALIPAY') ||
        descUpper.includes('ALIBABA') || descUpper.includes('ALI EXPRESS') ||
        descUpper.startsWith('DL*ALIEXPRESS') || descUpper.includes('DL*ALI')
      );

      if (isMerchantConhecido && t.tipo_lancamento !== 'iof' && t.tipo_lancamento !== 'estorno') {
        const resultado = categorizarDeterministico(t.descricao);
        if (resultado.categoria !== null) {
          resultados[i] = { categoria: resultado.categoria, incluir: resultado.incluir };
          continue;
        }
      }

      // Forçar categoria por tipo_lancamento (vindo do parser/IA)
      if (t.tipo_lancamento && t.tipo_lancamento !== 'compra') {
        console.log(`[categorize] tipo_lancamento detectado: "${t.tipo_lancamento}" para "${t.descricao}"`);
      }
      if (t.tipo_lancamento === 'iof') {
        resultados[i] = { categoria: 'IOF', incluir: true };
        continue;
      }
      if (t.tipo_lancamento === 'estorno') {
        resultados[i] = { categoria: 'Estorno', incluir: false };
        continue;
      }
      if (t.tipo_lancamento === 'pagamento_antecipado') {
        resultados[i] = { categoria: 'Pagamento Fatura', incluir: false };
        continue;
      }
      if (t.tipo_lancamento === 'tarifa_cartao') {
        resultados[i] = { categoria: 'Tarifas Cartão', incluir: false };
        continue;
      }
      if (t.tipo_lancamento === 'pagamento_fatura') {
        resultados[i] = { categoria: 'Pagamento Fatura', incluir: false };
        continue;
      }

      const resultado = categorizarDeterministico(t.descricao);

      if (resultado.categoria !== null) {
        resultados[i] = { categoria: resultado.categoria, incluir: resultado.incluir };
      } else {
        duvidosos.push({ index: i, ...t });
        resultados[i] = null;
      }
    }

    // ===== PASSO 2: Se ha casos duvidosos, usar ML local -> Claude API =====
    let mlResolvidos = 0;
    let iaResolvidos = 0;

    if (duvidosos.length > 0) {
      // Passo 2a: Tentar modelo ML local primeiro
      const aindaDuvidosos = [];

      for (const d of duvidosos) {
        try {
          const mlResult = await categorizarML(d.descricao, d.valor, d.banco);

          if (mlResult && mlResult.confianca >= 0.8) {
            // Alta confiança: aceitar ML automaticamente
            const incluir = mlResult.tipo === 'PJ';
            resultados[d.index] = { categoria: mlResult.categoria, incluir };
            mlResolvidos++;
          } else if (mlResult && mlResult.confianca >= 0.5) {
            // Média confiança: aceitar ML mas marcar para revisão
            const incluir = mlResult.tipo === 'PJ';
            resultados[d.index] = { categoria: mlResult.categoria, incluir };
            mlResolvidos++;
          } else {
            // Baixa confiança ou ML indisponível: enviar para Claude API
            aindaDuvidosos.push(d);
          }
        } catch (mlError) {
          console.error('[ML] Erro na categorização:', mlError.message);
          aindaDuvidosos.push(d);
        }
      }

      if (mlResolvidos > 0) {
        console.log(`[categorize] ML local resolveu ${mlResolvidos}/${duvidosos.length} duvidosos`);
      }

      // Passo 2b: Restantes vão para Claude API
      if (aindaDuvidosos.length > 0 && process.env.ANTHROPIC_API_KEY) {
        try {
          const respostasIA = await categorizarComIA(aindaDuvidosos, tipo_cartao);

          for (let j = 0; j < aindaDuvidosos.length; j++) {
            const idx = aindaDuvidosos[j].index;
            if (respostasIA[j]) {
              resultados[idx] = respostasIA[j];
              iaResolvidos++;
            } else {
              resultados[idx] = { categoria: 'Outros', incluir: false };
            }
          }
        } catch (iaError) {
          console.error('Erro na IA, usando fallback:', iaError);
          for (const d of aindaDuvidosos) {
            resultados[d.index] = { categoria: 'Outros', incluir: false };
          }
        }
      } else if (aindaDuvidosos.length > 0) {
        for (const d of aindaDuvidosos) {
          resultados[d.index] = { categoria: 'Outros', incluir: false };
        }
      }
    }

    return NextResponse.json({
      resultados,
      stats: {
        total: transacoes.length,
        automaticos: transacoes.length - duvidosos.length,
        mlLocal: mlResolvidos,
        analisadosIA: iaResolvidos
      }
    });

  } catch (error) {
    console.error('Erro ao categorizar:', error);
    return NextResponse.json({ error: 'Erro ao processar categorizacao' }, { status: 500 });
  }
}

// ===== Funcao para chamar a IA apenas para casos duvidosos =====
async function categorizarComIA(duvidosos, tipoCartao) {
  const contextoCartao = tipoCartao === 'PJ'
    ? 'Este e um cartao EMPRESARIAL (PJ). Transacoes neste cartao tendem a ser gastos empresariais, a menos que sejam claramente pessoais (restaurantes, streaming, roupas, etc).'
    : tipoCartao === 'PF'
    ? 'Este e um cartao PESSOAL (PF). Transacoes neste cartao tendem a ser gastos pessoais, a menos que sejam claramente empresariais (ferramentas, ads, fornecedores, etc).'
    : 'Tipo do cartao nao informado. Na duvida, classifique como pessoal.';

  const prompt = `Voce e um especialista em contabilidade para e-commerce brasileiro. Analise estas ${duvidosos.length} transacoes e categorize cada uma com precisao.

CONTEXTO DO NEGOCIO:
- Empresa: ORNE (e-commerce de iluminacao/decoracao)
- Objetivo: Separar gastos empresariais (PJ) de gastos pessoais (PF) para contabilidade
- ${contextoCartao}

REGRA IMPORTANTE: AliExpress e SEMPRE empresarial (Pagamento Fornecedores) pois a empresa compra produtos no AliExpress.

PADROES COMUNS EM FATURAS BRASILEIRAS:
- MP* = Mercado Pago (geralmente compras pessoais ou transferencias)
- EC* = PagSeguro/Ecommerce (geralmente compras em vendedores individuais)
- PAG* = PagSeguro transferencias
- PAYPAL*FACEBOOKSER = Marketing Digital (Facebook Ads)
- PAYPAL*PAYPAL*FA = Marketing Digital (Facebook Ads)
- DL*ALIEXPRESS = Fornecedores (AliExpress) - SEMPRE PJ
- FACEBK*, FB* = Marketing Digital
- APPLE.COM/BILL = Geralmente pessoal (Apple Store, iCloud, etc)
- GOL, LATAM, AZUL = Passagens aereas pessoais
- IFD* = iFood (pessoal)
- EBN* = PlayStation/Sony (pessoal)

CATEGORIAS EMPRESARIAIS (incluir: true):
- Marketing Digital: Facebook Ads, Google Ads, Meta Ads, campanhas pagas
- Pagamento Fornecedores: AliExpress (SEMPRE), Alibaba, fornecedores de produtos
- Fretes: Correios, Jadlog, Loggi, Melhor Envio, Kangu, Mandae, Sequoia, transportadoras
- Taxas Checkout: Yampi, CartPanda, Shopify, NuvemShop, plataformas de venda
- IA e Automacao: OpenAI, ChatGPT, Claude, ferramentas de automacao, cloud (AWS, GCP)
- Design/Ferramentas: Canva, Adobe, Figma, ferramentas de design, hospedagem web
- Telefonia: BrDID, VOIP, Twilio, telefonia empresarial
- ERP: Tiny, Bling, sistemas de gestao
- Gestao: Trello, Notion, Asana, Zoom, Slack, ferramentas de produtividade
- Viagem Trabalho: APENAS se for claramente viagem a trabalho comprovada
- Outros PJ: Outros gastos claramente empresariais

CATEGORIAS ESPECIAIS (incluir: false):
- Estorno: Estornos, creditos na fatura, devolucoes, reembolsos, cashback, bonificacoes
- Pagamento Antecipado: Pagamentos antecipados de fatura

CATEGORIAS PESSOAIS (incluir: false):
- Pessoal: Compras pessoais, restaurantes, entretenimento, streaming, jogos
- Tarifas Cartao: Anuidades, seguros, taxas bancarias, tarifas do cartao
- Entretenimento: Netflix, Spotify, Disney+, jogos, lazer
- Transporte Pessoal: Uber, 99, taxi para uso pessoal
- Compras Pessoais: Roupas, eletronicos pessoais, presentes

REGRA CRITICA SOBRE TARIFAS: Descricoes contendo "ANUIDADE", "SEG CONTA", "Fatura Segura", "AVAL EMERG", "Tarifa de uso", "SEGURO FATURA", "CREDITO EMERG", "TARIFA" devem ser SEMPRE categorizadas como "Tarifas Cartao" (incluir: false). NUNCA categorize essas como "Compra de Cambio" ou qualquer outra categoria.

REGRA DE OURO: Na duvida entre empresarial e pessoal, SEMPRE opte por PESSOAL (incluir: false) para evitar problemas fiscais.

TRANSACOES PARA ANALISAR:
${duvidosos.map((d, i) => `${i + 1}. "${d.descricao}" - R$ ${d.valor}`).join('\n')}

IMPORTANTE: Retorne APENAS um JSON valido, sem explicacoes:
{"resultados":[{"categoria":"NomeDaCategoria","incluir":true},...]}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Erro API Claude:', response.status, errorText);
    throw new Error(`Erro na API Claude: ${response.status}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || '';

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    const result = JSON.parse(jsonMatch[0]);
    return result.resultados || [];
  }

  return [];
}

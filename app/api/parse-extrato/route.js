import { NextResponse } from 'next/server';
import { parseOFX, isValidOFX, calcularTotais } from '@/lib/ofx-parser';
import { categorizeAll, identificarReembolsos, calcularResumoPorCategoria } from '@/lib/categorize-extrato';

// Modelo para fallback com PDF
const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

export async function POST(request) {
  try {
    const formData = await request.formData();
    const file = formData.get('pdf') || formData.get('file');
    const banco = formData.get('banco') || '';

    if (!file) {
      return NextResponse.json(
        { error: 'Nenhum arquivo enviado' },
        { status: 400 }
      );
    }

    // Obter nome e extensão do arquivo
    const fileName = file.name || '';
    const fileExtension = fileName.split('.').pop()?.toLowerCase();

    // Ler conteúdo do arquivo
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // ===== PROCESSAMENTO OFX (PRIORITÁRIO) =====
    if (fileExtension === 'ofx' || fileExtension === 'qfx') {
      const content = buffer.toString('utf-8');

      // Validar se é OFX válido
      if (!isValidOFX(content)) {
        return NextResponse.json(
          { error: 'Arquivo OFX inválido ou corrompido' },
          { status: 400 }
        );
      }

      // Parse determinístico do OFX
      const resultado = parseOFX(content);

      if (!resultado.success || resultado.movimentacoes.length === 0) {
        return NextResponse.json(
          { error: 'Nenhuma movimentação encontrada no arquivo OFX' },
          { status: 400 }
        );
      }

      // Categorizar movimentações
      const movimentacoesCat = categorizeAll(resultado.movimentacoes);

      // Calcular totais
      const totais = calcularTotais(movimentacoesCat);

      // Identificar reembolsos
      const reembolsos = identificarReembolsos(movimentacoesCat);

      // Calcular resumo por categoria
      const resumoPorCategoria = calcularResumoPorCategoria(movimentacoesCat);

      return NextResponse.json({
        success: true,
        metodo: 'OFX_PARSER',
        banco: resultado.banco || banco,
        banco_codigo: resultado.banco_codigo,
        conta: resultado.conta,
        periodo_inicio: resultado.periodo_inicio,
        periodo_fim: resultado.periodo_fim,
        saldo_final: resultado.saldo_final,
        movimentacoes: movimentacoesCat,
        total_movimentacoes: movimentacoesCat.length,
        total_entradas: totais.total_entradas,
        total_saidas: totais.total_saidas,
        saldo_periodo: totais.saldo_periodo,
        quantidade_entradas: totais.quantidade_entradas,
        quantidade_saidas: totais.quantidade_saidas,
        reembolsos_identificados: reembolsos,
        total_reembolsos: reembolsos.reduce((sum, r) => sum + r.valor, 0),
        resumo_categorias: resumoPorCategoria
      });
    }

    // ===== PROCESSAMENTO PDF (COM IA) =====
    if (fileExtension === 'pdf') {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return NextResponse.json(
          { error: 'ANTHROPIC_API_KEY não configurada. Use arquivo OFX para processamento sem IA.' },
          { status: 500 }
        );
      }

      // ===== PASSO 1: Extrair texto do PDF para ajudar a IA =====
      let textoExtraido = '';
      let bancoDetectado = banco || '';

      try {
        const pdfParse = (await import('pdf-parse')).default;
        const pdfData = await pdfParse(buffer);
        textoExtraido = pdfData.text || '';
        console.log(`[parse-extrato] Texto extraído: ${textoExtraido.length} caracteres`);

        // Detectar banco automaticamente pelo conteúdo do PDF
        if (!bancoDetectado) {
          bancoDetectado = detectarBancoExtrato(textoExtraido, fileName);
        }
        console.log(`[parse-extrato] Banco detectado: ${bancoDetectado}`);
      } catch (parseError) {
        console.error('[parse-extrato] Erro no pdf-parse:', parseError.message);
        // Continua mesmo sem texto extraído — a IA lê o PDF visualmente
      }

      // Se o banco não foi detectado, tenta pelo nome do arquivo
      if (!bancoDetectado) {
        bancoDetectado = detectarBancoExtrato('', fileName);
      }

      const base64 = buffer.toString('base64');

      // ===== PASSO 2: Montar prompt específico por banco =====
      const promptBanco = getPromptPorBanco(bancoDetectado);
      const textoContexto = textoExtraido.length > 200
        ? `\n\nTEXTO EXTRAÍDO DO PDF (para contexto adicional, pode estar desordenado):\n${textoExtraido.substring(0, 8000)}`
        : '';

      const prompt = `Você é um especialista em extrair movimentações de extratos bancários brasileiros.
Analise este PDF de extrato bancário e extraia TODAS as movimentações financeiras.

BANCO IDENTIFICADO: ${bancoDetectado || 'Não identificado — detecte automaticamente'}

${promptBanco}

REGRAS OBRIGATÓRIAS:
1. EXTRAIA absolutamente TODAS as movimentações — entradas E saídas
2. Para cada linha com data e valor, isso É uma movimentação — extraia
3. Data SEMPRE no formato DD/MM/YYYY (se o ano não está visível, use o ano do período do extrato)
4. Valor SEMPRE positivo (número com ponto decimal, ex: 1234.56)
5. TIPO: "entrada" para créditos/depósitos/recebimentos, "saida" para débitos/pagamentos/transferências enviadas
6. NÃO inclua: saldo anterior, saldo final, saldo disponível, saldo bloqueado, saldo total
7. NÃO inclua: cabeçalhos, rodapés, números de página
8. NÃO duplique movimentações
9. INCLUA a descrição COMPLETA (razão social, CPF/CNPJ se visível, tipo PIX/TED/DOC, etc.)
10. Se uma movimentação tem valor negativo ou é débito/saída, tipo = "saida"
11. Se uma movimentação tem valor positivo ou é crédito/entrada, tipo = "entrada"

COMO DISTINGUIR ENTRADAS DE SAÍDAS:
- PIX Enviado, Transferência Enviada, TED Enviada, Pagamento, Débito = SAÍDA
- PIX Recebido, Transferência Recebida, TED Recebida, Depósito, Crédito = ENTRADA
- Valores com sinal negativo (-) ou indicador D (débito) = SAÍDA
- Valores com sinal positivo (+) ou indicador C (crédito) = ENTRADA
- Tarifas, taxas, IOF = SAÍDA
- Rendimentos, juros creditados = ENTRADA
${textoContexto}

Retorne APENAS um JSON válido, SEM markdown, SEM blocos de código:
{
  "movimentacoes": [
    {
      "data": "DD/MM/YYYY",
      "descricao": "descrição completa da movimentação",
      "valor": 123.45,
      "tipo": "entrada" ou "saida"
    }
  ],
  "banco_detectado": "nome do banco",
  "periodo_inicio": "DD/MM/YYYY",
  "periodo_fim": "DD/MM/YYYY",
  "saldo_final": 0.00
}`;

      const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 16384,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'document',
                  source: {
                    type: 'base64',
                    media_type: 'application/pdf',
                    data: base64,
                  },
                },
                {
                  type: 'text',
                  text: prompt,
                },
              ],
            },
          ],
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('Erro da API Anthropic:', response.status, errorData);

        let errorMsg = `API Anthropic retornou ${response.status}`;
        if (errorData.error?.message) {
          errorMsg += `: ${errorData.error.message}`;
        }

        return NextResponse.json(
          {
            error: `${errorMsg}. Considere usar arquivo OFX.`,
            details: errorData
          },
          { status: 500 }
        );
      }

      const data = await response.json();
      const responseText = data.content?.[0]?.text || '';

      let result;
      try {
        const cleanJson = responseText
          .replace(/```json\n?/g, '')
          .replace(/```\n?/g, '')
          .trim();
        result = JSON.parse(cleanJson);
      } catch (parseError) {
        console.error('Erro ao fazer parse do JSON:', parseError);
        console.error('Resposta raw (primeiros 500 chars):', responseText.substring(0, 500));
        return NextResponse.json(
          {
            error: 'Erro ao processar resposta da IA. Considere usar arquivo OFX.',
            raw_response: responseText.substring(0, 500)
          },
          { status: 500 }
        );
      }

      if (!result.movimentacoes || !Array.isArray(result.movimentacoes)) {
        return NextResponse.json(
          { error: 'Estrutura de resposta inválida' },
          { status: 500 }
        );
      }

      // Formatar movimentações do PDF
      const movimentacoesFormatadas = result.movimentacoes.map((m, index) => ({
        id: `pdf_${Date.now()}_${index}`,
        data: formatarDataPDF(m.data),
        descricao: m.descricao,
        valor: Math.abs(parseFloat(m.valor) || 0),
        tipo: m.tipo || 'saida',
        documento: null
      })).filter(m => m.valor > 0);

      // Categorizar
      const movimentacoesCat = categorizeAll(movimentacoesFormatadas);
      const totais = calcularTotais(movimentacoesCat);
      const reembolsos = identificarReembolsos(movimentacoesCat);
      const resumoPorCategoria = calcularResumoPorCategoria(movimentacoesCat);

      return NextResponse.json({
        success: true,
        metodo: 'PDF_IA',
        modelo_usado: ANTHROPIC_MODEL,
        banco: result.banco_detectado || bancoDetectado || banco,
        periodo_inicio: result.periodo_inicio || null,
        periodo_fim: result.periodo_fim || null,
        saldo_final: result.saldo_final || null,
        movimentacoes: movimentacoesCat,
        total_movimentacoes: movimentacoesCat.length,
        total_entradas: totais.total_entradas,
        total_saidas: totais.total_saidas,
        saldo_periodo: totais.saldo_periodo,
        quantidade_entradas: totais.quantidade_entradas,
        quantidade_saidas: totais.quantidade_saidas,
        reembolsos_identificados: reembolsos,
        total_reembolsos: reembolsos.reduce((sum, r) => sum + r.valor, 0),
        resumo_categorias: resumoPorCategoria,
        aviso: 'Processado via IA. Para maior precisão, use arquivo OFX.'
      });
    }

    // Extensão não suportada
    return NextResponse.json(
      {
        error: `Formato de arquivo não suportado: .${fileExtension}`,
        formatos_aceitos: ['ofx', 'qfx', 'pdf'],
        recomendacao: 'Prefira usar arquivo OFX para maior precisão'
      },
      { status: 400 }
    );

  } catch (error) {
    console.error('Erro no parse-extrato:', error);
    return NextResponse.json(
      {
        error: 'Erro ao processar arquivo',
        details: error.message
      },
      { status: 500 }
    );
  }
}

/**
 * Detecta o banco pelo conteúdo do texto ou nome do arquivo
 */
function detectarBancoExtrato(texto, fileName = '') {
  const conteudo = (texto + ' ' + fileName).toUpperCase();

  if (conteudo.includes('C6 BANK') || conteudo.includes('C6 S.A') || conteudo.includes('BANCO C6') || conteudo.includes('C6 CONSIG')) {
    return 'C6 Bank';
  }
  if (conteudo.includes('ITAÚ') || conteudo.includes('ITAU UNIBANCO') || conteudo.includes('ITAUCARD')) {
    return 'Itaú';
  }
  if (conteudo.includes('NUBANK') || conteudo.includes('NU PAGAMENTOS')) {
    return 'Nubank';
  }
  if (conteudo.includes('SANTANDER') || conteudo.includes('BANCO SANTANDER')) {
    return 'Santander';
  }
  if (conteudo.includes('BRADESCO') || conteudo.includes('BANCO BRADESCO')) {
    return 'Bradesco';
  }
  if (conteudo.includes('INTER') || conteudo.includes('BANCO INTER')) {
    return 'Banco Inter';
  }
  if (conteudo.includes('BANCO DO BRASIL') || conteudo.includes('BB S.A')) {
    return 'Banco do Brasil';
  }
  if (conteudo.includes('CAIXA') || conteudo.includes('CEF')) {
    return 'Caixa Econômica';
  }

  return '';
}

/**
 * Retorna instruções específicas de parsing por banco
 */
function getPromptPorBanco(banco) {
  const bancoParsers = {
    'C6 Bank': `
FORMATO ESPECÍFICO DO EXTRATO C6 BANK:
- O extrato C6 Bank é organizado por datas, com movimentações agrupadas por dia
- Cada movimentação tem: data, descrição e valor
- O formato da data pode ser DD/MM/YYYY ou DD MMM YYYY (ex: "15 JAN 2025")
- Valores de SAÍDA aparecem com sinal negativo (-) ou prefixo "D" ou na cor vermelha
- Valores de ENTRADA aparecem com sinal positivo (+) ou prefixo "C" ou na cor verde/azul
- PIX enviados são SAÍDA, PIX recebidos são ENTRADA
- TEDs, DOCs são classificados da mesma forma
- O extrato pode ter seções: "Movimentações", "Resumo", "Saldo"
- IGNORE a seção de "Resumo" e "Saldo" — extraia apenas "Movimentações"
- Tarifas de manutenção, IOF, taxas bancárias são SAÍDA
- Rendimentos de CDB, aplicação automática são ENTRADA
- Resgates de CDB/poupança são ENTRADA
- Aplicações em CDB/poupança são SAÍDA
- "Pagamento efetuado" ou "Pagto" = SAÍDA
- "Transferência enviada" = SAÍDA
- "Transferência recebida" = ENTRADA

ATENÇÃO ESPECIAL C6 BANK:
- O C6 Bank pode mostrar "Pix enviado - NOME DA PESSOA - CPF" — extraia tudo como descrição
- Pode ter "Pagamento de boleto - NOME DO BENEFICIÁRIO" — extraia completo
- "Compra no débito" = SAÍDA
- "Rendimento" ou "Rentabilidade" = ENTRADA
- Se aparecer "Saldo anterior" ou "Saldo do dia" — NÃO extraia, é informação de saldo
`,
    'Itaú': `
FORMATO ESPECÍFICO DO EXTRATO ITAÚ:
- Formato tabular: DATA | LANÇAMENTOS | RAZÃO SOCIAL | CNPJ/CPF | VALOR | SALDO
- Créditos (entradas) são indicados com C ou valor positivo
- Débitos (saídas) são indicados com D ou valor negativo
- "SALDO ANTERIOR", "SALDO DO DIA", "S A L D O" devem ser IGNORADOS
- "REND PAGO APLIC AUT" = Rendimento (ENTRADA)
- "APLIC AUT MAIS" = Aplicação automática (SAÍDA)
- "RESG APLIC AUT" = Resgate aplicação (ENTRADA)
`,
    'Nubank': `
FORMATO ESPECÍFICO DO EXTRATO NUBANK:
- Layout minimalista com data, descrição e valor
- Transferências enviadas/recebidas bem identificadas
- "Transferência enviada" = SAÍDA
- "Transferência recebida" = ENTRADA
- "Pagamento de boleto" = SAÍDA
- "Compra no débito" = SAÍDA
`,
    'Santander': `
FORMATO ESPECÍFICO DO EXTRATO SANTANDER:
- Formato tabular com DATA, HISTÓRICO, DOCUMENTO, VALOR (D/C), SALDO
- D = Débito (SAÍDA), C = Crédito (ENTRADA)
- IGNORE linhas com "SALDO" no histórico
`,
    'Bradesco': `
FORMATO ESPECÍFICO DO EXTRATO BRADESCO:
- Similar ao Itaú com DATA, HISTÓRICO, DOCTO, VALOR, SALDO
- Débitos com sinal negativo
- Créditos com sinal positivo
`,
    'Banco Inter': `
FORMATO ESPECÍFICO DO EXTRATO BANCO INTER:
- Layout moderno similar ao Nubank
- PIX identificados com "Pix enviado"/"Pix recebido"
- "TED enviada" = SAÍDA
- "Pagamento" = SAÍDA
`,
  };

  return bancoParsers[banco] || `
FORMATO GENÉRICO DE EXTRATO BANCÁRIO:
- Procure por padrões de DATA + DESCRIÇÃO + VALOR
- Identifique se valores negativos, "D" (débito) ou vermelho = SAÍDA
- Valores positivos, "C" (crédito) ou verde/azul = ENTRADA
- IGNORE linhas de saldo (saldo anterior, saldo disponível, saldo final)
`;
}

/**
 * Formatar data do PDF para ISO
 */
function formatarDataPDF(dataStr) {
  if (!dataStr) return null;

  // Já está no formato ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(dataStr)) {
    return dataStr;
  }

  // Formato DD/MM/YYYY
  const match = dataStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (match) {
    const [, dia, mes, ano] = match;
    return `${ano}-${mes}-${dia}`;
  }

  // Formato DD/MM/YY
  const matchShort = dataStr.match(/(\d{2})\/(\d{2})\/(\d{2})/);
  if (matchShort) {
    const [, dia, mes, ano] = matchShort;
    const anoFull = parseInt(ano) > 50 ? `19${ano}` : `20${ano}`;
    return `${anoFull}-${mes}-${dia}`;
  }

  // Formato DD MMM YYYY (ex: 15 JAN 2025)
  const meses = {
    'JAN': '01', 'FEV': '02', 'MAR': '03', 'ABR': '04',
    'MAI': '05', 'JUN': '06', 'JUL': '07', 'AGO': '08',
    'SET': '09', 'OUT': '10', 'NOV': '11', 'DEZ': '12'
  };
  const matchNome = dataStr.toUpperCase().match(/(\d{1,2})\s*(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)\s*(\d{4})/);
  if (matchNome) {
    const [, dia, mesNome, ano] = matchNome;
    const mes = meses[mesNome];
    return `${ano}-${mes}-${dia.padStart(2, '0')}`;
  }

  return null;
}

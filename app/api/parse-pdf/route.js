import { NextResponse } from 'next/server';

import { detectarBanco, getPipeline } from '@/lib/pdf-parsers/index.js';
import { filtrarTransacoesIA, corrigirEstornosIA, calcularAuditoria } from '@/lib/pdf-parsers/utils.js';

// Timeout de 300s para chamadas IA com PDF visual (PicPay, Santander)
export const maxDuration = 300;

const ANTHROPIC_MODEL = 'claude-opus-4-6';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MAX_TOKENS = 128000;
const MIN_TRANSACOES_PARSER = 3;
const DEPLOY_VERSION = 'v4-diag-2';

export async function POST(request) {
  try {
    const formData = await request.formData();

    const file = formData.get('pdf');
    const cartaoNome = formData.get('cartao_nome') || '';
    const tipoCartao = formData.get('tipo_cartao') || '';

    if (!file) {
      return NextResponse.json(
        { error: 'Nenhum arquivo enviado' },
        { status: 400 }
      );
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // ===== PASSO 1: Extração de texto + pipeline determinístico =====
    let textoExtraido = '';
    let bancoDetectado = 'desconhecido';
    let pipelineResult = null;
    let pipeline = null;
    let metadadosParser = null;

    try {
      const pdfParse = (await import('pdf-parse')).default;
      const pdfData = await pdfParse(buffer);
      textoExtraido = pdfData.text || '';

      bancoDetectado = detectarBanco(textoExtraido + ' ' + cartaoNome);
      pipeline = getPipeline(bancoDetectado);

      console.log(`[parse-pdf] Texto extraído: ${textoExtraido.length} caracteres`);
      console.log(`[parse-pdf] Banco detectado: ${bancoDetectado} (pipeline: ${pipeline.BANK_ID})`);

      // DIAG: sempre capturar info do texto para debug quando PicPay
      if (bancoDetectado === 'picpay') {
        const lines = textoExtraido.split('\n');
        if (!metadadosParser) metadadosParser = {};
        metadadosParser._diag_text_length = textoExtraido.length;
        metadadosParser._diag_total_lines = lines.length;
        metadadosParser._diag_picpay_card_lines = lines.filter(l => /picpay card/i.test(l)).map(l => l.substring(0, 80));
        metadadosParser._diag_subtotal_lines = lines.filter(l => /subtotal/i.test(l)).map(l => l.substring(0, 80));
        metadadosParser._diag_first_30_lines = lines.slice(0, 30).map(l => l.substring(0, 100));
        metadadosParser._diag_text_sample = textoExtraido.substring(0, 500);
        metadadosParser._diag_banco = bancoDetectado;
      }

      if (textoExtraido.length > 100) {
        pipelineResult = pipeline.extractPipeline(textoExtraido);

        // Extrair metadados para uso na IA
        if (pipelineResult?.metadados_verificacao) {
          metadadosParser = { ...metadadosParser, ...pipelineResult.metadados_verificacao };
        } else if (pipelineResult?.auditoria) {
          metadadosParser = {
            ...metadadosParser,
            total_fatura_pdf: pipelineResult.auditoria.total_fatura_pdf,
            subtotais: pipelineResult.auditoria.subtotais_pdf || [],
          };
        }
        console.log(`[parse-pdf] metadadosParser.total_fatura_pdf: ${metadadosParser?.total_fatura_pdf}`);

        // Se pipeline NÃO precisa de IA e tem transações suficientes, retorna direto
        if (!pipelineResult?.needsAI &&
            pipelineResult?.transacoes?.length >= MIN_TRANSACOES_PARSER) {

          console.log(`[parse-pdf] Parser determinístico bem-sucedido: ${pipelineResult.transacoes.length} transações`);
          console.log(`[parse-pdf] Auditoria: reconciliado=${pipelineResult.auditoria?.reconciliado}, total_fatura_pdf=${pipelineResult.auditoria?.total_fatura_pdf}, diff=${pipelineResult.auditoria?.diferenca_centavos}`);

          return NextResponse.json({
            success: true,
            transacoes: pipelineResult.transacoes,
            total_encontrado: pipelineResult.transacoes.length,
            valor_total: pipelineResult.transacoes
              .filter(t => t.tipo_lancamento === 'compra')
              .reduce((sum, t) => sum + (t.valor || 0), 0),
            banco_detectado: bancoDetectado,
            metodo: 'PARSER_DETERMINISTICO',
            auditoria: pipelineResult.auditoria,
            deploy_version: DEPLOY_VERSION
          });
        }

        if (pipelineResult?.needsAI) {
          console.log(`[parse-pdf] Pipeline ${bancoDetectado} requer IA visual`);
        } else {
          console.log(`[parse-pdf] Pipeline retornou poucas transações (${pipelineResult?.transacoes?.length || 0}), usando IA`);
        }
      }
    } catch (parseError) {
      console.error('[parse-pdf] Erro no pdf-parse/pipeline:', parseError.message, parseError.stack?.split('\n').slice(0, 5).join(' | '));
      // Preservar erro para debug na resposta
      if (!metadadosParser) metadadosParser = {};
      metadadosParser._pipeline_error = `${parseError.message} | ${parseError.stack?.split('\n').slice(1, 4).join(' | ') || ''}`;
    }

    // ===== PASSO 2: IA visual (fallback ou forçada pelo pipeline) =====
    console.log(`[parse-pdf] Usando IA para extração...`);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      // Retorna o que o parser conseguiu, ou erro
      if (pipelineResult?.transacoes?.length > 0) {
        return NextResponse.json({
          success: true,
          transacoes: pipelineResult.transacoes,
          total_encontrado: pipelineResult.transacoes.length,
          valor_total: pipelineResult.transacoes
            .filter(t => t.tipo_lancamento === 'compra')
            .reduce((sum, t) => sum + (t.valor || 0), 0),
          banco_detectado: bancoDetectado,
          metodo: 'PARSER_DETERMINISTICO_PARCIAL',
          auditoria: pipelineResult.auditoria
        });
      }

      return NextResponse.json(
        { error: 'ANTHROPIC_API_KEY não configurada e parser determinístico falhou' },
        { status: 500 }
      );
    }

    // Pedir ao pipeline o prompt específico do banco
    if (!pipeline) {
      pipeline = getPipeline(bancoDetectado);
    }

    const prompt = pipeline.buildAIPrompt(cartaoNome, tipoCartao, metadadosParser);
    if (!prompt) {
      // Pipeline não suporta IA — deveria ter retornado resultados determinísticos
      console.error(`[parse-pdf] Pipeline ${bancoDetectado} não fornece prompt de IA`);
      return NextResponse.json(
        { error: `Pipeline ${bancoDetectado} não suporta extração por IA` },
        { status: 500 }
      );
    }

    console.log(`[parse-pdf] Usando prompt do pipeline ${pipeline.BANK_ID}`);

    const base64 = buffer.toString('base64');

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: ANTHROPIC_MAX_TOKENS,
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

    console.log(`[parse-pdf] Anthropic API status: ${response.status}`);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('[parse-pdf] Erro da API Anthropic:', response.status, JSON.stringify(errorData).substring(0, 500));

      // Fallback: retorna resultado parcial do parser se disponível
      if (pipelineResult?.transacoes?.length > 0) {
        return NextResponse.json({
          success: true,
          transacoes: pipelineResult.transacoes,
          total_encontrado: pipelineResult.transacoes.length,
          valor_total: pipelineResult.transacoes
            .filter(t => t.tipo_lancamento === 'compra')
            .reduce((sum, t) => sum + (t.valor || 0), 0),
          banco_detectado: bancoDetectado,
          metodo: 'PARSER_DETERMINISTICO_FALLBACK',
          aviso: 'IA indisponível, usando parser determinístico',
          auditoria: pipelineResult.auditoria
        });
      }

      let errorMsg = `API Anthropic retornou ${response.status}`;
      if (errorData.error?.message) {
        errorMsg += `: ${errorData.error.message}`;
      }

      return NextResponse.json(
        { error: errorMsg, details: errorData },
        { status: 500 }
      );
    }

    const data = await response.json();
    const responseText = data.content?.[0]?.text || '';
    console.log(`[parse-pdf] Anthropic response: model=${data.model}, stop_reason=${data.stop_reason}, usage=${JSON.stringify(data.usage)}`);
    console.log(`[parse-pdf] responseText length: ${responseText.length}, primeiros 300 chars: ${responseText.substring(0, 300)}`);

    // Parse do JSON da IA
    let result;
    try {
      const cleanJson = responseText
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
      result = JSON.parse(cleanJson);
    } catch (parseError) {
      // Fallback: tentar extrair JSON via regex (IA pode retornar texto extra antes/depois)
      console.warn('[parse-pdf] JSON.parse direto falhou, tentando regex...', parseError.message);
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          result = JSON.parse(jsonMatch[0]);
          console.log('[parse-pdf] JSON extraído via regex com sucesso');
        } catch (regexParseError) {
          console.error('[parse-pdf] Regex parse também falhou:', regexParseError.message);
        }
      }

      if (!result) {
        console.error('[parse-pdf] Não foi possível extrair JSON da resposta da IA');
        console.error('[parse-pdf] Primeiros 500 chars da resposta:', responseText.substring(0, 500));

        if (pipelineResult?.transacoes?.length > 0) {
          return NextResponse.json({
            success: true,
            transacoes: pipelineResult.transacoes,
            total_encontrado: pipelineResult.transacoes.length,
            valor_total: pipelineResult.transacoes
              .filter(t => t.tipo_lancamento === 'compra')
              .reduce((sum, t) => sum + (t.valor || 0), 0),
            banco_detectado: bancoDetectado,
            metodo: 'PARSER_DETERMINISTICO_FALLBACK',
            aviso: 'IA retornou resposta inválida, usando parser determinístico',
            auditoria: pipelineResult.auditoria
          });
        }

        return NextResponse.json(
          {
            error: 'Erro ao processar resposta da IA',
            details: 'A IA não retornou um JSON válido. Tente novamente.',
            resposta_ia_preview: responseText.substring(0, 300)
          },
          { status: 500 }
        );
      }
    }

    if (!result.transacoes || !Array.isArray(result.transacoes)) {
      return NextResponse.json(
        { error: 'Estrutura de resposta inválida', details: 'O campo transacoes não foi encontrado ou não é um array' },
        { status: 500 }
      );
    }

    // ===== PASSO 3: Pós-processamento IA =====

    console.log(`[parse-pdf] IA retornou ${result.transacoes?.length || 0} transações brutas`);

    // Normalizar tipo_lancamento
    let transacoes = result.transacoes.map(t => ({
      ...t,
      tipo_lancamento: t.tipo_lancamento || 'compra'
    }));
    const countNormalizadas = transacoes.length;

    // Filtro universal (remove subtotais, pagamentos, limites)
    transacoes = filtrarTransacoesIA(transacoes);
    const countAposFiltro = transacoes.length;
    console.log(`[parse-pdf] Após filtrarTransacoesIA: ${transacoes.length} transações (removidas: ${countNormalizadas - countAposFiltro})`);

    // Correções específicas do pipeline (cada banco pode ter suas regras)
    transacoes = pipeline.postAICorrections(transacoes, metadadosParser);
    const countAposCorrections = transacoes.length;
    console.log(`[parse-pdf] Após postAICorrections: ${transacoes.length} transações`);

    // Correção genérica de estornos mal-classificados
    // Prioridade para total_fatura_pdf: metadados do parser > resposta da IA > null
    // Usa ?? (nullish coalescing) em vez de || para não tratar 0 como falsy
    const totalFaturaPDF = metadadosParser?.total_fatura_pdf
      ?? (result.total_a_pagar ? parseFloat(result.total_a_pagar) : null)
      ?? null;
    console.log(`[parse-pdf] total_fatura_pdf: ${totalFaturaPDF} (metadados: ${metadadosParser?.total_fatura_pdf}, IA: ${result.total_a_pagar})`);
    transacoes = corrigirEstornosIA(transacoes, totalFaturaPDF);
    const countAposEstornos = transacoes.length;
    console.log(`[parse-pdf] Após corrigirEstornosIA: ${transacoes.length} transações`);

    // Calcular auditoria (com resumo da fatura para Mercado Pago — fórmula completa do ciclo)
    const auditoria = calcularAuditoria(transacoes, totalFaturaPDF, metadadosParser?.resumo_fatura);
    if (metadadosParser?.subtotais) {
      auditoria.subtotais_pdf = metadadosParser.subtotais;
    }

    const metodo = pipelineResult?.needsAI ? 'IA_PDF_HIBRIDO' : 'IA_PDF';

    console.log(`[parse-pdf] Total final: ${transacoes.length} transações (método: ${metodo})`);
    if (auditoria.reconciliado !== null) {
      console.log(`[parse-pdf] Reconciliação: ${auditoria.reconciliado ? 'OK' : 'DIVERGENTE'} (diferença: ${auditoria.diferenca_centavos} centavos)`);
    }

    return NextResponse.json({
      success: true,
      transacoes,
      total_encontrado: result.total_encontrado || transacoes.length,
      valor_total: result.valor_total || transacoes
        .filter(t => t.tipo_lancamento === 'compra')
        .reduce((sum, t) => sum + (t.valor || 0), 0),
      banco_detectado: result.banco_detectado || bancoDetectado,
      metodo,
      auditoria,
      debug: {
        model: data.model,
        stop_reason: data.stop_reason,
        usage: data.usage,
        ia_transacoes_brutas: result.transacoes?.length || 0,
        apos_filtrarTransacoesIA: countAposFiltro,
        apos_postAICorrections: countAposCorrections,
        apos_corrigirEstornosIA: countAposEstornos,
        transacoes_finais: transacoes.length,
        total_fatura_pdf_usado: totalFaturaPDF,
        ia_response_length: responseText.length,
        ia_response_preview: responseText.substring(0, 500),
        primeiras_3_transacoes_ia: result.transacoes?.slice(0, 3),
        pipeline_error: metadadosParser?._pipeline_error || null,
        diag_text_length: metadadosParser?._diag_text_length || null,
        diag_total_lines: metadadosParser?._diag_total_lines || null,
        diag_picpay_card_lines: metadadosParser?._diag_picpay_card_lines || null,
        diag_subtotal_lines: metadadosParser?._diag_subtotal_lines || null,
        diag_first_30_lines: metadadosParser?._diag_first_30_lines || null,
        diag_text_sample: metadadosParser?._diag_text_sample || null,
        pipeline_needsAI: pipelineResult?.needsAI ?? null,
        pipeline_txns: pipelineResult?.transacoes?.length ?? 0,
        deploy_version: DEPLOY_VERSION
      }
    });

  } catch (error) {
    console.error('Erro no parse-pdf:', error);

    return NextResponse.json(
      { error: 'Erro ao processar PDF', details: error.message },
      { status: 500 }
    );
  }
}

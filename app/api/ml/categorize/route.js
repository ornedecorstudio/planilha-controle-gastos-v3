import { NextResponse } from 'next/server'
import { categorizarML, categorizarMLBatch, getMLInfo } from '@/lib/ml/categorizer'

// POST - Categorizar transação(ões) via modelo ML local
export async function POST(request) {
  try {
    const body = await request.json()

    // Suporta single ou batch
    if (body.transacoes && Array.isArray(body.transacoes)) {
      // Modo batch
      const resultados = await categorizarMLBatch(body.transacoes)

      const stats = {
        total: body.transacoes.length,
        categorizados: resultados.filter(r => r !== null).length,
        alta_confianca: resultados.filter(r => r && r.confianca >= 0.8).length,
        media_confianca: resultados.filter(r => r && r.confianca >= 0.5 && r.confianca < 0.8).length,
        baixa_confianca: resultados.filter(r => r && r.confianca < 0.5).length,
        falhas: resultados.filter(r => r === null).length
      }

      return NextResponse.json({ resultados, stats })
    }

    // Modo single
    const { descricao, valor, banco } = body

    if (!descricao) {
      return NextResponse.json({ error: 'Campo descricao é obrigatório' }, { status: 400 })
    }

    const resultado = await categorizarML(descricao, parseFloat(valor) || 0, banco)

    if (!resultado) {
      return NextResponse.json({
        error: 'Modelo ML não disponível',
        fallback: 'Use /api/categorize para categorização via regras + IA'
      }, { status: 503 })
    }

    return NextResponse.json(resultado)

  } catch (error) {
    console.error('Erro na API ml/categorize:', error)
    return NextResponse.json({ error: 'Erro ao processar categorização ML' }, { status: 500 })
  }
}

// GET - Informações sobre o modelo ML
export async function GET() {
  try {
    const info = await getMLInfo()
    return NextResponse.json(info)
  } catch (error) {
    console.error('Erro na API ml/categorize GET:', error)
    return NextResponse.json({ error: 'Erro ao obter info do modelo' }, { status: 500 })
  }
}

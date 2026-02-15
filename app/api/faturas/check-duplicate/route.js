import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

const ANTHROPIC_MODEL = 'claude-opus-4-20250514'
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'

// POST - Verifica se a fatura ja existe usando IA para comparar PDFs
export async function POST(request) {
  try {
    const supabase = createServerClient()
    const formData = await request.formData()

    const cartao_id = formData.get('cartao_id')
    const mes_referencia = formData.get('mes_referencia')
    const pdf = formData.get('pdf')
    const transacoes_preview = formData.get('transacoes_preview') // JSON das transacoes extraidas

    if (!cartao_id || !mes_referencia) {
      return NextResponse.json({ error: 'cartao_id e mes_referencia sao obrigatorios' }, { status: 400 })
    }

    // Verifica se ja existe fatura para este cartao e mes
    const { data: faturaExistente, error: fetchError } = await supabase
      .from('faturas')
      .select('id, valor_total, valor_pj, valor_pf, pdf_url')
      .eq('cartao_id', cartao_id)
      .eq('mes_referencia', `${mes_referencia}-01`)
      .single()

    if (fetchError && fetchError.code !== 'PGRST116') {
      // PGRST116 = nenhum resultado encontrado (ok)
      console.error('Erro ao verificar fatura:', fetchError)
      return NextResponse.json({ error: fetchError.message }, { status: 500 })
    }

    if (!faturaExistente) {
      return NextResponse.json({
        duplicada: false,
        message: 'Nenhuma fatura existente para este cartao e mes'
      })
    }

    // Se tem transacoes_preview, compara com as existentes
    if (transacoes_preview) {
      const novasTransacoes = JSON.parse(transacoes_preview)

      // Busca transacoes existentes
      const { data: transacoesExistentes } = await supabase
        .from('transacoes')
        .select('data, descricao, valor')
        .eq('fatura_id', faturaExistente.id)
        .limit(50)

      if (transacoesExistentes && transacoesExistentes.length > 0) {
        // Calcula similaridade entre as transacoes
        const totalExistentes = transacoesExistentes.length
        const valorTotalExistentes = transacoesExistentes.reduce((sum, t) => sum + parseFloat(t.valor || 0), 0)
        const valorTotalNovas = novasTransacoes.reduce((sum, t) => sum + parseFloat(t.valor || 0), 0)

        // Se o valor total for muito proximo (diferenca < 5%), provavelmente e duplicada
        const diferencaPercentual = Math.abs(valorTotalExistentes - valorTotalNovas) / valorTotalExistentes * 100

        if (diferencaPercentual < 5) {
          // Verifica se pelo menos 50% das transacoes existem
          let matchCount = 0
          for (const nova of novasTransacoes.slice(0, 20)) {
            const match = transacoesExistentes.find(e =>
              Math.abs(parseFloat(e.valor) - parseFloat(nova.valor)) < 0.01 &&
              (e.descricao || '').substring(0, 20).toUpperCase() === (nova.descricao || '').substring(0, 20).toUpperCase()
            )
            if (match) matchCount++
          }

          const matchPercentual = (matchCount / Math.min(20, novasTransacoes.length)) * 100

          if (matchPercentual > 50) {
            return NextResponse.json({
              duplicada: true,
              fatura_existente_id: faturaExistente.id,
              similaridade: matchPercentual.toFixed(0),
              valor_existente: valorTotalExistentes,
              valor_nova: valorTotalNovas,
              message: `Esta fatura parece ser duplicada. ${matchPercentual.toFixed(0)}% das transacoes ja existem no sistema.`
            })
          }
        }
      }
    }

    // Se chegou aqui, a fatura ja existe mas nao conseguimos confirmar se e duplicada
    return NextResponse.json({
      duplicada: true,
      fatura_existente_id: faturaExistente.id,
      similaridade: 'desconhecida',
      valor_existente: faturaExistente.valor_total,
      message: 'Ja existe uma fatura para este cartao e mes. Deseja substituir?'
    })

  } catch (error) {
    console.error('Erro ao verificar duplicidade:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

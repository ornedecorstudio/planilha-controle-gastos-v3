import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

// GET - Exportar dados categorizados para treino do modelo ML
export async function GET() {
  try {
    const supabase = createServerClient()

    // 1. Buscar transacoes categorizadas (faturas de cartao)
    const { data: transacoes, error: errTx } = await supabase
      .from('transacoes')
      .select(`
        descricao,
        valor,
        categoria,
        tipo,
        metodo,
        tipo_lancamento,
        faturas!inner (
          cartoes!inner (
            banco,
            nome
          )
        )
      `)
      .not('categoria', 'is', null)
      .not('categoria', 'eq', 'Outros')
      .not('categoria', 'eq', 'Estorno')
      .not('categoria', 'eq', 'Pagamento Fatura')

    if (errTx) {
      console.error('Erro ao buscar transacoes:', errTx)
      return NextResponse.json({ error: errTx.message }, { status: 500 })
    }

    // 2. Buscar movimentacoes categorizadas (extratos bancarios)
    const { data: movimentacoes, error: errMov } = await supabase
      .from('movimentacoes')
      .select(`
        descricao,
        valor,
        categoria,
        tipo,
        extratos!inner (
          banco
        )
      `)
      .not('categoria', 'is', null)
      .not('categoria', 'eq', 'Outros')

    if (errMov) {
      console.error('Erro ao buscar movimentacoes:', errMov)
      return NextResponse.json({ error: errMov.message }, { status: 500 })
    }

    // 3. Normalizar para formato unificado
    const dadosTreino = []

    for (const t of (transacoes || [])) {
      dadosTreino.push({
        descricao: t.descricao,
        valor: parseFloat(t.valor),
        categoria: t.categoria,
        tipo: t.tipo || 'PJ',
        metodo: t.metodo || 'automatico',
        banco: t.faturas?.cartoes?.banco || 'desconhecido',
        origem: 'transacao'
      })
    }

    for (const m of (movimentacoes || [])) {
      // Movimentacoes nao tem tipo PJ/PF direto, mas sao da conta PJ
      dadosTreino.push({
        descricao: m.descricao,
        valor: parseFloat(m.valor),
        categoria: m.categoria,
        tipo: 'PJ',
        metodo: 'automatico',
        banco: m.extratos?.banco || 'desconhecido',
        origem: 'movimentacao'
      })
    }

    // 4. Estatisticas
    const categorias = {}
    let manuais = 0
    for (const d of dadosTreino) {
      const key = `${d.tipo}:${d.categoria}`
      categorias[key] = (categorias[key] || 0) + 1
      if (d.metodo === 'manual') manuais++
    }

    return NextResponse.json({
      total: dadosTreino.length,
      manuais,
      categorias,
      dados: dadosTreino
    })

  } catch (error) {
    console.error('Erro na API training-data:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

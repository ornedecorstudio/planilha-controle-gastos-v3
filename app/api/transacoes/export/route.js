import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

// GET - Exporta transacoes de uma fatura como CSV
export async function GET(request) {
  try {
    const supabase = createServerClient()
    const { searchParams } = new URL(request.url)

    const fatura_id = searchParams.get('fatura_id')

    if (!fatura_id) {
      return NextResponse.json({ error: 'fatura_id e obrigatorio' }, { status: 400 })
    }

    // Busca fatura para o nome do arquivo
    const { data: fatura } = await supabase
      .from('faturas')
      .select('mes_referencia, cartoes(nome)')
      .eq('id', fatura_id)
      .single()

    // Busca transacoes
    const { data: transacoes, error } = await supabase
      .from('transacoes')
      .select('data, descricao, valor, categoria, tipo')
      .eq('fatura_id', fatura_id)
      .order('data', { ascending: true })

    if (error) {
      console.error('Erro ao buscar transacoes:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!transacoes || transacoes.length === 0) {
      return NextResponse.json({ error: 'Nenhuma transacao encontrada' }, { status: 404 })
    }

    // Gera CSV
    const headers = ['Data', 'Descrição', 'Valor', 'Categoria', 'Tipo']
    const rows = transacoes.map(t => [
      t.data ? new Date(t.data + 'T12:00:00').toLocaleDateString('pt-BR') : '',
      `"${(t.descricao || '').replace(/"/g, '""')}"`,
      (parseFloat(t.valor) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      t.categoria || '',
      t.tipo || ''
    ])

    const csv = [
      headers.join(';'),
      ...rows.map(row => row.join(';'))
    ].join('\n')

    // Nome do arquivo
    const mesRef = fatura?.mes_referencia
      ? new Date(fatura.mes_referencia).toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' }).replace(' ', '-')
      : 'fatura'
    const cartaoNome = fatura?.cartoes?.nome?.replace(/\s+/g, '-') || 'cartao'
    const filename = `transacoes-${cartaoNome}-${mesRef}.csv`

    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`
      }
    })

  } catch (error) {
    console.error('Erro na API export:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

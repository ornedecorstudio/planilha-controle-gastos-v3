import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

/**
 * GET - Exporta movimentações de um extrato em formato CSV
 */
export async function GET(request) {
  try {
    const supabase = createServerClient()
    const { searchParams } = new URL(request.url)

    const extrato_id = searchParams.get('extrato_id')

    if (!extrato_id) {
      return NextResponse.json({ error: 'extrato_id é obrigatório' }, { status: 400 })
    }

    // Buscar extrato para informações do cabeçalho
    const { data: extrato, error: extratoError } = await supabase
      .from('extratos')
      .select('*')
      .eq('id', extrato_id)
      .single()

    if (extratoError || !extrato) {
      return NextResponse.json({ error: 'Extrato não encontrado' }, { status: 404 })
    }

    // Buscar todas as movimentações do extrato
    const { data: movimentacoes, error: movError } = await supabase
      .from('movimentacoes')
      .select('*')
      .eq('extrato_id', extrato_id)
      .order('data', { ascending: true })

    if (movError) {
      console.error('Erro ao buscar movimentações:', movError)
      return NextResponse.json({ error: movError.message }, { status: 500 })
    }

    // Formatar data para DD/MM/YYYY
    const formatDate = (date) => {
      if (!date) return ''
      const d = new Date(date + 'T12:00:00')
      return d.toLocaleDateString('pt-BR')
    }

    // Formatar valor para número brasileiro
    const formatValue = (value) => {
      return parseFloat(value || 0).toLocaleString('pt-BR', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      })
    }

    // Cabeçalhos do CSV
    const headers = ['Data', 'Descrição', 'Valor', 'Tipo', 'Categoria']

    // Linhas do CSV
    const rows = (movimentacoes || []).map(m => [
      formatDate(m.data),
      `"${(m.descricao || '').replace(/"/g, '""')}"`, // Escape aspas duplas
      formatValue(m.valor),
      m.tipo === 'entrada' ? 'Entrada' : 'Saída',
      m.categoria || 'Outros'
    ])

    // Montar CSV completo
    const csvContent = [
      headers.join(';'),
      ...rows.map(row => row.join(';'))
    ].join('\n')

    // Nome do arquivo
    const mesRef = extrato.mes_referencia
      ? new Date(extrato.mes_referencia).toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' }).replace(' ', '-')
      : 'extrato'
    const banco = (extrato.banco || 'banco').replace(/\s+/g, '-').toLowerCase()
    const filename = `movimentacoes-${banco}-${mesRef}.csv`

    // Retornar como download
    return new NextResponse(csvContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })

  } catch (error) {
    console.error('Erro na exportação CSV:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

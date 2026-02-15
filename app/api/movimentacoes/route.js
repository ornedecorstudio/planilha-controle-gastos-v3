import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

// GET - Lista movimentações de um extrato
export async function GET(request) {
  try {
    const supabase = createServerClient()
    const { searchParams } = new URL(request.url)

    const extrato_id = searchParams.get('extrato_id')
    const tipo = searchParams.get('tipo') // 'entrada' ou 'saida'
    const categoria = searchParams.get('categoria')
    const limit = parseInt(searchParams.get('limit')) || 500

    if (!extrato_id) {
      return NextResponse.json({ error: 'extrato_id é obrigatório' }, { status: 400 })
    }

    let query = supabase
      .from('movimentacoes')
      .select('*')
      .eq('extrato_id', extrato_id)
      .order('data', { ascending: true })
      .limit(limit)

    if (tipo) {
      query = query.eq('tipo', tipo)
    }

    if (categoria) {
      query = query.eq('categoria', categoria)
    }

    const { data, error } = await query

    if (error) {
      console.error('Erro ao buscar movimentações:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ movimentacoes: data })

  } catch (error) {
    console.error('Erro na API movimentações:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

// DELETE - Remove movimentação individual ou em lote
export async function DELETE(request) {
  try {
    const supabase = createServerClient()
    const { searchParams } = new URL(request.url)

    const id = searchParams.get('id')
    const ids = searchParams.get('ids')
    const extrato_id = searchParams.get('extrato_id')

    // Deleção individual
    if (id) {
      // Buscar extrato_id antes de deletar para recalcular totais
      const { data: movimentacao } = await supabase
        .from('movimentacoes')
        .select('extrato_id')
        .eq('id', id)
        .single()

      if (!movimentacao) {
        return NextResponse.json({ error: 'Movimentação não encontrada' }, { status: 404 })
      }

      const { error } = await supabase
        .from('movimentacoes')
        .delete()
        .eq('id', id)

      if (error) {
        console.error('Erro ao deletar movimentação:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      // Recalcula totais do extrato
      await recalcularTotaisExtrato(supabase, movimentacao.extrato_id)

      return NextResponse.json({
        success: true,
        message: 'Movimentação removida'
      })
    }

    // Deleção em lote por IDs
    if (ids) {
      const idList = ids.split(',').filter(Boolean)

      if (idList.length === 0) {
        return NextResponse.json({ error: 'Nenhum ID fornecido' }, { status: 400 })
      }

      // Buscar extrato_id da primeira movimentação
      const { data: primeiraMovimentacao } = await supabase
        .from('movimentacoes')
        .select('extrato_id')
        .eq('id', idList[0])
        .single()

      if (!primeiraMovimentacao) {
        return NextResponse.json({ error: 'Movimentações não encontradas' }, { status: 404 })
      }

      const { error } = await supabase
        .from('movimentacoes')
        .delete()
        .in('id', idList)

      if (error) {
        console.error('Erro ao deletar movimentações:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      // Recalcula totais do extrato
      await recalcularTotaisExtrato(supabase, primeiraMovimentacao.extrato_id)

      return NextResponse.json({
        success: true,
        message: `${idList.length} movimentações removidas`,
        quantidade: idList.length
      })
    }

    return NextResponse.json({ error: 'Parâmetros inválidos' }, { status: 400 })

  } catch (error) {
    console.error('Erro na API movimentações DELETE:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

// PATCH - Atualiza uma movimentação
export async function PATCH(request) {
  try {
    const supabase = createServerClient()
    const body = await request.json()

    const { id, categoria, tipo } = body

    if (!id) {
      return NextResponse.json({ error: 'ID da movimentação é obrigatório' }, { status: 400 })
    }

    const updateData = {}
    if (categoria) updateData.categoria = categoria
    if (tipo) updateData.tipo = tipo

    const { data, error } = await supabase
      .from('movimentacoes')
      .update(updateData)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      console.error('Erro ao atualizar movimentação:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Recalcula totais se o tipo mudou
    if (tipo && data.extrato_id) {
      await recalcularTotaisExtrato(supabase, data.extrato_id)
    }

    return NextResponse.json({ movimentacao: data })

  } catch (error) {
    console.error('Erro na API movimentações PATCH:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

// Função auxiliar para recalcular totais do extrato
async function recalcularTotaisExtrato(supabase, extrato_id) {
  const { data: todasMovimentacoes } = await supabase
    .from('movimentacoes')
    .select('valor, tipo')
    .eq('extrato_id', extrato_id)

  const totalEntradas = (todasMovimentacoes || [])
    .filter(m => m.tipo === 'entrada')
    .reduce((acc, m) => acc + parseFloat(m.valor), 0)

  const totalSaidas = (todasMovimentacoes || [])
    .filter(m => m.tipo === 'saida')
    .reduce((acc, m) => acc + parseFloat(m.valor), 0)

  await supabase
    .from('extratos')
    .update({
      total_entradas: totalEntradas,
      total_saidas: totalSaidas,
      saldo: totalEntradas - totalSaidas
    })
    .eq('id', extrato_id)

  return { totalEntradas, totalSaidas, saldo: totalEntradas - totalSaidas }
}

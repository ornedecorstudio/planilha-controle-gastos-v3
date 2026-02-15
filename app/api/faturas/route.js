import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

// GET - Lista faturas com filtros opcionais ou busca uma fatura especifica
export async function GET(request) {
  try {
    const supabase = createServerClient()
    const { searchParams } = new URL(request.url)

    const id = searchParams.get('id')
    const cartao_id = searchParams.get('cartao_id')
    const status = searchParams.get('status')
    const ano = searchParams.get('ano')
    const limit = parseInt(searchParams.get('limit')) || 50

    // Se tem ID, busca fatura especifica
    if (id) {
      const { data, error } = await supabase
        .from('faturas')
        .select(`
          *,
          cartoes (
            id,
            nome,
            banco,
            tipo
          )
        `)
        .eq('id', id)
        .single()

      if (error) {
        console.error('Erro ao buscar fatura:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      return NextResponse.json({ fatura: data })
    }

    // Senao, lista todas com filtros
    let query = supabase
      .from('faturas')
      .select(`
        *,
        cartoes (
          id,
          nome,
          banco,
          tipo
        )
      `)
      .order('mes_referencia', { ascending: false })
      .limit(limit)

    if (cartao_id) {
      query = query.eq('cartao_id', cartao_id)
    }

    if (status) {
      query = query.eq('status', status)
    }

    if (ano) {
      query = query
        .gte('mes_referencia', `${ano}-01-01`)
        .lte('mes_referencia', `${ano}-12-31`)
    }

    const { data, error } = await query

    if (error) {
      console.error('Erro ao buscar faturas:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ faturas: data })

  } catch (error) {
    console.error('Erro na API faturas:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

// POST - Cria nova fatura
export async function POST(request) {
  try {
    const supabase = createServerClient()
    const body = await request.json()
    
    const { cartao_id, mes_referencia, data_vencimento, status } = body
    
    if (!cartao_id || !mes_referencia) {
      return NextResponse.json({ error: 'cartao_id e mes_referencia sao obrigatorios' }, { status: 400 })
    }
    
    const { data, error } = await supabase
      .from('faturas')
      .insert([{
        cartao_id,
        mes_referencia,
        data_vencimento: data_vencimento || null,
        status: status || 'pendente',
        valor_total: 0,
        valor_pj: 0,
        valor_pf: 0
      }])
      .select()
      .single()
    
    if (error) {
      console.error('Erro ao criar fatura:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    
    return NextResponse.json({ fatura: data }, { status: 201 })
    
  } catch (error) {
    console.error('Erro na API faturas:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

// PATCH - Atualiza status da fatura
export async function PATCH(request) {
  try {
    const supabase = createServerClient()
    const body = await request.json()

    const { id, status, data_pagamento } = body

    if (!id) {
      return NextResponse.json({ error: 'ID da fatura e obrigatorio' }, { status: 400 })
    }

    const updateData = {}
    if (status) updateData.status = status
    if (data_pagamento) updateData.data_pagamento = data_pagamento

    const { data, error } = await supabase
      .from('faturas')
      .update(updateData)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      console.error('Erro ao atualizar fatura:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ fatura: data })

  } catch (error) {
    console.error('Erro na API faturas:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

// DELETE - Remove fatura(s) e suas transacoes
export async function DELETE(request) {
  try {
    const supabase = createServerClient()
    const { searchParams } = new URL(request.url)

    const id = searchParams.get('id')
    const ids = searchParams.get('ids')

    // Delecao individual
    if (id) {
      // Primeiro deleta todas as transacoes da fatura
      const { error: transacoesError } = await supabase
        .from('transacoes')
        .delete()
        .eq('fatura_id', id)

      if (transacoesError) {
        console.error('Erro ao deletar transacoes:', transacoesError)
        return NextResponse.json({ error: transacoesError.message }, { status: 500 })
      }

      // Depois deleta a fatura
      const { error } = await supabase
        .from('faturas')
        .delete()
        .eq('id', id)

      if (error) {
        console.error('Erro ao deletar fatura:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      return NextResponse.json({
        success: true,
        message: 'Fatura e transacoes removidas'
      })
    }

    // Delecao em lote por IDs
    if (ids) {
      const idList = ids.split(',').filter(Boolean)

      if (idList.length === 0) {
        return NextResponse.json({ error: 'Nenhum ID fornecido' }, { status: 400 })
      }

      // Primeiro deleta todas as transacoes das faturas
      const { error: transacoesError } = await supabase
        .from('transacoes')
        .delete()
        .in('fatura_id', idList)

      if (transacoesError) {
        console.error('Erro ao deletar transacoes:', transacoesError)
        return NextResponse.json({ error: transacoesError.message }, { status: 500 })
      }

      // Depois deleta as faturas
      const { error } = await supabase
        .from('faturas')
        .delete()
        .in('id', idList)

      if (error) {
        console.error('Erro ao deletar faturas:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      return NextResponse.json({
        success: true,
        message: `${idList.length} faturas e suas transacoes removidas`,
        quantidade: idList.length
      })
    }

    return NextResponse.json({ error: 'Parametros invalidos' }, { status: 400 })

  } catch (error) {
    console.error('Erro na API faturas DELETE:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

/**
 * Gera uma hash única para identificar uma movimentação
 * Tripla checagem: data + valor + descrição normalizada
 */
function gerarHashMovimentacao(mov) {
  const data = mov.data || ''
  const valor = parseFloat(mov.valor || 0).toFixed(2)
  const descricaoNormalizada = (mov.descricao || '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 100) // Primeiros 100 chars para comparação

  return `${data}|${valor}|${descricaoNormalizada}`
}

/**
 * Verifica se uma movimentação é duplicada
 * Critérios de duplicação:
 * 1. Mesma data
 * 2. Mesmo valor (com tolerância de R$ 0.01)
 * 3. Descrição similar (primeiros 50 caracteres)
 */
function isDuplicada(nova, existentes) {
  const novaData = nova.data || ''
  const novaValor = parseFloat(nova.valor || 0)
  const novaDesc = (nova.descricao || '').toUpperCase().substring(0, 50)

  return existentes.some(existente => {
    const existenteData = existente.data || ''
    const existenteValor = parseFloat(existente.valor || 0)
    const existenteDesc = (existente.descricao || '').toUpperCase().substring(0, 50)

    // Critério 1: Mesma data
    const mesmaData = novaData === existenteData

    // Critério 2: Mesmo valor (tolerância de R$ 0.01)
    const mesmoValor = Math.abs(novaValor - existenteValor) <= 0.01

    // Critério 3: Descrição similar (80% match ou início igual)
    const descricaoSimilar = novaDesc === existenteDesc ||
      novaDesc.startsWith(existenteDesc.substring(0, 30)) ||
      existenteDesc.startsWith(novaDesc.substring(0, 30))

    // Considera duplicada se TODOS os critérios forem atendidos
    return mesmaData && mesmoValor && descricaoSimilar
  })
}

// GET - Lista extratos com filtros opcionais
export async function GET(request) {
  try {
    const supabase = createServerClient()
    const { searchParams } = new URL(request.url)

    const banco = searchParams.get('banco')
    const ano = searchParams.get('ano')
    const limit = parseInt(searchParams.get('limit')) || 50

    let query = supabase
      .from('extratos')
      .select('*')
      .order('mes_referencia', { ascending: false })
      .limit(limit)

    if (banco) {
      query = query.eq('banco', banco)
    }

    if (ano) {
      query = query
        .gte('mes_referencia', `${ano}-01-01`)
        .lte('mes_referencia', `${ano}-12-31`)
    }

    const { data, error } = await query

    if (error) {
      console.error('Erro ao buscar extratos:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ extratos: data })

  } catch (error) {
    console.error('Erro na API extratos:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

// POST - Cria novo extrato com movimentações (com detecção de duplicatas)
export async function POST(request) {
  try {
    const supabase = createServerClient()
    const body = await request.json()

    const { banco, mes_referencia, movimentacoes } = body

    if (!banco || !mes_referencia) {
      return NextResponse.json({ error: 'banco e mes_referencia são obrigatórios' }, { status: 400 })
    }

    if (!movimentacoes || !Array.isArray(movimentacoes) || movimentacoes.length === 0) {
      return NextResponse.json({ error: 'movimentacoes é obrigatório e deve ser um array' }, { status: 400 })
    }

    // Buscar movimentações existentes do mesmo período para detectar duplicatas
    const mesInicio = mes_referencia.substring(0, 7) + '-01'
    const mesFim = mes_referencia.substring(0, 7) + '-31'

    const { data: movimentacoesExistentes } = await supabase
      .from('movimentacoes')
      .select('data, descricao, valor, tipo')
      .gte('data', mesInicio)
      .lte('data', mesFim)

    // Filtrar movimentações duplicadas
    const movimentacoesNovas = []
    const movimentacoesDuplicadas = []

    for (const mov of movimentacoes) {
      if (movimentacoesExistentes && isDuplicada(mov, movimentacoesExistentes)) {
        movimentacoesDuplicadas.push(mov)
      } else {
        // Verificar também duplicatas dentro do próprio lote
        if (!isDuplicada(mov, movimentacoesNovas)) {
          movimentacoesNovas.push(mov)
        } else {
          movimentacoesDuplicadas.push(mov)
        }
      }
    }

    // Se todas são duplicadas, retornar aviso
    if (movimentacoesNovas.length === 0) {
      return NextResponse.json({
        warning: 'Todas as movimentações já existem no banco de dados',
        duplicadas: movimentacoesDuplicadas.length,
        inseridas: 0
      }, { status: 200 })
    }

    // Calcular totais apenas das novas
    const totalEntradas = movimentacoesNovas
      .filter(m => m.tipo === 'entrada')
      .reduce((sum, m) => sum + (parseFloat(m.valor) || 0), 0)

    const totalSaidas = movimentacoesNovas
      .filter(m => m.tipo === 'saida')
      .reduce((sum, m) => sum + (parseFloat(m.valor) || 0), 0)

    // Criar extrato
    const { data: extrato, error: extratoError } = await supabase
      .from('extratos')
      .insert([{
        banco,
        mes_referencia,
        total_entradas: totalEntradas,
        total_saidas: totalSaidas,
        saldo: totalEntradas - totalSaidas
      }])
      .select()
      .single()

    if (extratoError) {
      console.error('Erro ao criar extrato:', extratoError)
      return NextResponse.json({ error: extratoError.message }, { status: 500 })
    }

    // Inserir apenas movimentações novas
    const movimentacoesParaInserir = movimentacoesNovas.map(m => ({
      extrato_id: extrato.id,
      data: m.data,
      descricao: m.descricao,
      valor: parseFloat(m.valor) || 0,
      tipo: m.tipo || 'saida',
      categoria: m.categoria || 'Outros'
    }))

    const { data: movs, error: movsError } = await supabase
      .from('movimentacoes')
      .insert(movimentacoesParaInserir)
      .select()

    if (movsError) {
      console.error('Erro ao inserir movimentações:', movsError)
      // Deletar o extrato se as movimentações falharem
      await supabase.from('extratos').delete().eq('id', extrato.id)
      return NextResponse.json({ error: movsError.message }, { status: 500 })
    }

    return NextResponse.json({
      extrato,
      quantidade: movs.length,
      total_entradas: totalEntradas,
      total_saidas: totalSaidas,
      duplicadas_ignoradas: movimentacoesDuplicadas.length,
      message: movimentacoesDuplicadas.length > 0
        ? `${movs.length} movimentações inseridas, ${movimentacoesDuplicadas.length} duplicadas ignoradas`
        : `${movs.length} movimentações inseridas com sucesso`
    }, { status: 201 })

  } catch (error) {
    console.error('Erro na API extratos:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

// DELETE - Remove extrato(s) e suas movimentações
export async function DELETE(request) {
  try {
    const supabase = createServerClient()
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    const ids = searchParams.get('ids')

    // Batch delete (múltiplos extratos)
    if (ids) {
      const idList = ids.split(',').filter(Boolean)
      if (idList.length === 0) {
        return NextResponse.json({ error: 'Lista de IDs vazia' }, { status: 400 })
      }

      // Deletar movimentações primeiro
      await supabase.from('movimentacoes').delete().in('extrato_id', idList)

      // Deletar extratos
      const { error } = await supabase.from('extratos').delete().in('id', idList)

      if (error) {
        console.error('Erro ao deletar extratos em batch:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      return NextResponse.json({ success: true, quantidade: idList.length })
    }

    // Single delete
    if (!id) {
      return NextResponse.json({ error: 'ID do extrato é obrigatório' }, { status: 400 })
    }

    // Deletar movimentações primeiro
    await supabase.from('movimentacoes').delete().eq('extrato_id', id)

    // Deletar extrato
    const { error } = await supabase
      .from('extratos')
      .delete()
      .eq('id', id)

    if (error) {
      console.error('Erro ao deletar extrato:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })

  } catch (error) {
    console.error('Erro na API extratos:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

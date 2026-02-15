import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

// GET - Dados agregados para o dashboard
export async function GET(request) {
  try {
    const supabase = createServerClient()
    const { searchParams } = new URL(request.url)
    
    // Parametros opcionais
    const ano = searchParams.get('ano') || new Date().getFullYear()
    const mes = searchParams.get('mes') // Se nao informado, retorna do ano todo
    
    // 1. Resumo de faturas
    let queryFaturas = supabase
      .from('faturas')
      .select(`
        id,
        mes_referencia,
        valor_total,
        valor_pj,
        valor_pf,
        status,
        cartoes (
          nome,
          banco
        )
      `)
      .gte('mes_referencia', `${ano}-01-01`)
      .lte('mes_referencia', `${ano}-12-31`)
      .order('mes_referencia', { ascending: false })
    
    if (mes) {
      const mesFormatado = mes.toString().padStart(2, '0')
      queryFaturas = queryFaturas
        .gte('mes_referencia', `${ano}-${mesFormatado}-01`)
        .lte('mes_referencia', `${ano}-${mesFormatado}-31`)
    }
    
    const { data: faturas, error: errorFaturas } = await queryFaturas
    
    if (errorFaturas) {
      console.error('Erro ao buscar faturas:', errorFaturas)
      return NextResponse.json({ error: errorFaturas.message }, { status: 500 })
    }
    
    // 2. Calcula totais gerais
    const totaisGerais = {
      valor_total: faturas.reduce((acc, f) => acc + parseFloat(f.valor_total || 0), 0),
      valor_pj: faturas.reduce((acc, f) => acc + parseFloat(f.valor_pj || 0), 0),
      valor_pf: faturas.reduce((acc, f) => acc + parseFloat(f.valor_pf || 0), 0),
      quantidade_faturas: faturas.length,
      faturas_pendentes: faturas.filter(f => f.status === 'pendente').length,
      faturas_pagas: faturas.filter(f => f.status === 'pago').length,
      faturas_reembolsadas: faturas.filter(f => f.status === 'reembolsado').length
    }
    
    // 3. Busca transacoes para agrupar por categoria
    const faturaIds = faturas.map(f => f.id)
    
    let categoriasPorTipo = { PJ: {}, PF: {} }
    
    if (faturaIds.length > 0) {
      const { data: transacoes, error: errorTransacoes } = await supabase
        .from('transacoes')
        .select('categoria, tipo, valor')
        .in('fatura_id', faturaIds)
      
      if (!errorTransacoes && transacoes) {
        transacoes.forEach(t => {
          const tipo = t.tipo || 'PJ'
          const categoria = t.categoria || 'Outros'
          
          if (!categoriasPorTipo[tipo][categoria]) {
            categoriasPorTipo[tipo][categoria] = { valor: 0, quantidade: 0 }
          }
          
          categoriasPorTipo[tipo][categoria].valor += parseFloat(t.valor || 0)
          categoriasPorTipo[tipo][categoria].quantidade += 1
        })
      }
    }
    
    // Converte para array ordenado por valor
    const categoriasArray = (tipo) => {
      return Object.entries(categoriasPorTipo[tipo])
        .map(([nome, dados]) => ({ nome, ...dados }))
        .sort((a, b) => b.valor - a.valor)
    }
    
    // 4. Resumo por mes (para grafico)
    const resumoPorMes = {}
    faturas.forEach(f => {
      const mesRef = f.mes_referencia.substring(0, 7) // YYYY-MM
      if (!resumoPorMes[mesRef]) {
        resumoPorMes[mesRef] = { valor_pj: 0, valor_pf: 0, valor_total: 0 }
      }
      resumoPorMes[mesRef].valor_pj += parseFloat(f.valor_pj || 0)
      resumoPorMes[mesRef].valor_pf += parseFloat(f.valor_pf || 0)
      resumoPorMes[mesRef].valor_total += parseFloat(f.valor_total || 0)
    })
    
    const evolucaoMensal = Object.entries(resumoPorMes)
      .map(([mes, valores]) => ({ mes, ...valores }))
      .sort((a, b) => a.mes.localeCompare(b.mes))
    
    // 5. Reembolsos pendentes
    const { data: reembolsosPendentes } = await supabase
      .from('faturas')
      .select(`
        id,
        mes_referencia,
        valor_pj,
        cartoes (nome)
      `)
      .eq('status', 'pago')
      .gt('valor_pj', 0)
      .order('mes_referencia', { ascending: false })
      .limit(10)
    
    return NextResponse.json({
      ano: parseInt(ano),
      mes: mes ? parseInt(mes) : null,
      totais: totaisGerais,
      categorias_pj: categoriasArray('PJ'),
      categorias_pf: categoriasArray('PF'),
      evolucao_mensal: evolucaoMensal,
      faturas_recentes: faturas.slice(0, 5),
      reembolsos_pendentes: reembolsosPendentes || []
    })
    
  } catch (error) {
    console.error('Erro na API dashboard:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

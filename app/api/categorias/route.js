import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

// GET - Lista todas as categorias ativas
export async function GET(request) {
  try {
    const supabase = createServerClient()
    const { searchParams } = new URL(request.url)
    const tipo = searchParams.get('tipo') // 'PJ', 'PF' ou null para todas
    
    let query = supabase
      .from('categorias')
      .select('*')
      .eq('ativo', true)
      .order('nome')
    
    if (tipo) {
      query = query.eq('tipo', tipo)
    }
    
    const { data, error } = await query
    
    if (error) {
      console.error('Erro ao buscar categorias:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    
    return NextResponse.json({ categorias: data })
    
  } catch (error) {
    console.error('Erro na API categorias:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

// GET - Lista todos os cartoes ativos
export async function GET() {
  try {
    const supabase = createServerClient()
    
    const { data, error } = await supabase
      .from('cartoes')
      .select('*')
      .eq('ativo', true)
      .order('nome')
    
    if (error) {
      console.error('Erro ao buscar cartoes:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    
    return NextResponse.json({ cartoes: data })
    
  } catch (error) {
    console.error('Erro na API cartoes:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

// POST - Adiciona novo cartao
export async function POST(request) {
  try {
    const supabase = createServerClient()
    const body = await request.json()
    
    const { nome, banco, tipo, ultimos_digitos } = body
    
    if (!nome || !banco || !tipo) {
      return NextResponse.json({ error: 'Campos obrigatorios: nome, banco, tipo' }, { status: 400 })
    }
    
    const { data, error } = await supabase
      .from('cartoes')
      .insert([{ nome, banco, tipo, ultimos_digitos, ativo: true }])
      .select()
      .single()
    
    if (error) {
      console.error('Erro ao criar cartao:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    
    return NextResponse.json({ cartao: data }, { status: 201 })
    
  } catch (error) {
    console.error('Erro na API cartoes:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

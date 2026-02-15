import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

/**
 * POST - Faz upload de arquivo (PDF, OFX, QFX) para o Supabase Storage
 * 
 * Suporta todos os tipos de arquivo de fatura:
 * - PDF: Faturas em formato PDF
 * - OFX/QFX: Arquivos de extrato bancário
 */
export async function POST(request) {
  try {
    const supabase = createServerClient()
    const formData = await request.formData()

    const fatura_id = formData.get('fatura_id')
    
    // Aceita tanto 'pdf' quanto 'arquivo' como nome do campo
    const arquivo = formData.get('pdf') || formData.get('arquivo')

    if (!fatura_id) {
      return NextResponse.json({ error: 'fatura_id e obrigatorio' }, { status: 400 })
    }

    if (!arquivo) {
      return NextResponse.json({ error: 'Arquivo e obrigatorio' }, { status: 400 })
    }

    // Detecta o tipo do arquivo
    const nomeOriginal = arquivo.name || 'arquivo'
    const extensao = nomeOriginal.split('.').pop()?.toLowerCase() || 'pdf'
    
    // Define o content type baseado na extensão
    const contentTypes = {
      'pdf': 'application/pdf',
      'ofx': 'application/x-ofx',
      'qfx': 'application/x-qfx'
    }
    const contentType = contentTypes[extensao] || 'application/octet-stream'

    // Converte o arquivo para buffer
    const bytes = await arquivo.arrayBuffer()
    const buffer = Buffer.from(bytes)

    // Nome do arquivo no storage: fatura_id.extensao
    const fileName = `faturas/${fatura_id}.${extensao}`

    // Upload para o bucket 'faturas'
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('faturas')
      .upload(fileName, buffer, {
        contentType,
        upsert: true // Substitui se já existir
      })

    if (uploadError) {
      console.error('Erro no upload:', uploadError)
      
      // Se o bucket não existe, retorna erro informativo
      if (uploadError.message?.includes('Bucket not found')) {
        return NextResponse.json({
          error: 'Bucket de storage nao configurado. Configure o bucket "faturas" no Supabase.',
          details: uploadError.message
        }, { status: 500 })
      }
      return NextResponse.json({ error: uploadError.message }, { status: 500 })
    }

    // Gera URL pública do arquivo
    const { data: urlData } = supabase.storage
      .from('faturas')
      .getPublicUrl(fileName)

    const arquivo_url = urlData?.publicUrl

    // Atualiza a fatura com a URL do arquivo e metadata
    const { error: updateError } = await supabase
      .from('faturas')
      .update({ 
        pdf_url: arquivo_url,  // Mantém compatibilidade com campo existente
        arquivo_tipo: extensao,
        arquivo_nome: nomeOriginal
      })
      .eq('id', fatura_id)

    if (updateError) {
      console.error('Erro ao atualizar fatura:', updateError)
      // Não falha se os campos novos não existirem ainda
      // Tenta atualizar apenas o pdf_url
      const { error: updateError2 } = await supabase
        .from('faturas')
        .update({ pdf_url: arquivo_url })
        .eq('id', fatura_id)
      
      if (updateError2) {
        return NextResponse.json({ error: updateError2.message }, { status: 500 })
      }
    }

    return NextResponse.json({
      success: true,
      arquivo_url,
      arquivo_tipo: extensao,
      arquivo_nome: nomeOriginal,
      message: 'Arquivo salvo com sucesso'
    })

  } catch (error) {
    console.error('Erro no upload do arquivo:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

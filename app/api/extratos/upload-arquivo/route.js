import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

/**
 * POST - Faz upload de arquivo (PDF, OFX, QFX) para o Supabase Storage
 *
 * Suporta todos os tipos de arquivo de extrato bancário:
 * - PDF: Extratos em formato PDF
 * - OFX/QFX: Arquivos de extrato bancário padrão Open Financial Exchange
 */
export async function POST(request) {
  try {
    const supabase = createServerClient()
    const formData = await request.formData()

    const extrato_id = formData.get('extrato_id')

    // Aceita tanto 'arquivo' quanto 'pdf' como nome do campo
    const arquivo = formData.get('arquivo') || formData.get('pdf')

    if (!extrato_id) {
      return NextResponse.json({ error: 'extrato_id é obrigatório' }, { status: 400 })
    }

    if (!arquivo) {
      return NextResponse.json({ error: 'Arquivo é obrigatório' }, { status: 400 })
    }

    // Detecta o tipo do arquivo
    const nomeOriginal = arquivo.name || 'arquivo'
    const extensao = nomeOriginal.split('.').pop()?.toLowerCase() || 'ofx'

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

    // Nome do arquivo no storage: extrato_id.extensao
    const fileName = `extratos/${extrato_id}.${extensao}`

    // Upload para o bucket 'extratos'
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('extratos')
      .upload(fileName, buffer, {
        contentType,
        upsert: true // Substitui se já existir
      })

    if (uploadError) {
      console.error('Erro no upload:', uploadError)

      // Se o bucket não existe, tenta criar no bucket 'faturas' como fallback
      if (uploadError.message?.includes('Bucket not found')) {
        // Tentar no bucket 'faturas' com prefixo 'extratos/'
        const { data: fallbackData, error: fallbackError } = await supabase.storage
          .from('faturas')
          .upload(fileName, buffer, {
            contentType,
            upsert: true
          })

        if (fallbackError) {
          return NextResponse.json({
            error: 'Bucket de storage não configurado. Configure o bucket "extratos" no Supabase.',
            details: uploadError.message
          }, { status: 500 })
        }

        // Gera URL pública do arquivo no bucket fallback
        const { data: urlData } = supabase.storage
          .from('faturas')
          .getPublicUrl(fileName)

        const arquivo_url = urlData?.publicUrl

        // Atualiza o extrato com a URL do arquivo e metadata
        await atualizarExtrato(supabase, extrato_id, arquivo_url, extensao, nomeOriginal)

        return NextResponse.json({
          success: true,
          arquivo_url,
          arquivo_tipo: extensao,
          arquivo_nome: nomeOriginal,
          message: 'Arquivo salvo com sucesso (bucket faturas)'
        })
      }

      return NextResponse.json({ error: uploadError.message }, { status: 500 })
    }

    // Gera URL pública do arquivo
    const { data: urlData } = supabase.storage
      .from('extratos')
      .getPublicUrl(fileName)

    const arquivo_url = urlData?.publicUrl

    // Atualiza o extrato com a URL do arquivo e metadata
    await atualizarExtrato(supabase, extrato_id, arquivo_url, extensao, nomeOriginal)

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

async function atualizarExtrato(supabase, extrato_id, arquivo_url, extensao, nomeOriginal) {
  // Atualiza o extrato com a URL do arquivo e metadata
  const { error: updateError } = await supabase
    .from('extratos')
    .update({
      arquivo_url,
      arquivo_tipo: extensao,
      arquivo_nome: nomeOriginal
    })
    .eq('id', extrato_id)

  if (updateError) {
    console.error('Erro ao atualizar extrato:', updateError)
    // Não falha se os campos novos não existirem ainda - apenas loga
    // Os campos podem ser adicionados via migration no Supabase
  }
}

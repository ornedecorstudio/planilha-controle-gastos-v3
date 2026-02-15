import { NextResponse } from 'next/server';
import { parseOFX, isValidOFX } from '@/lib/ofx-parser';

/**
 * Parser OFX para faturas de cartao de credito
 * Reutiliza o ofx-parser existente, filtra apenas debitos
 * Retorna formato compativel com parse-pdf
 */
export async function POST(request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') || formData.get('pdf');

    if (!file) {
      return NextResponse.json(
        { error: 'Nenhum arquivo enviado' },
        { status: 400 }
      );
    }

    // Ler conteudo do arquivo
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    const content = buffer.toString('utf-8');

    // Validar se e OFX
    if (!isValidOFX(content)) {
      return NextResponse.json(
        { error: 'Arquivo OFX invalido ou corrompido' },
        { status: 400 }
      );
    }

    // Parse deterministico
    const resultado = parseOFX(content);

    if (!resultado.success || !resultado.movimentacoes || resultado.movimentacoes.length === 0) {
      return NextResponse.json(
        { error: 'Nenhuma transacao encontrada no arquivo OFX' },
        { status: 400 }
      );
    }

    // Filtrar apenas debitos (compras) - ignorar creditos (pagamentos, estornos)
    const debitos = resultado.movimentacoes.filter(m => {
      // Ignorar creditos (pagamentos recebidos)
      if (m.tipo === 'entrada') return false;
      if (m.tipo_ofx === 'CREDIT') return false;

      // Ignorar pagamentos de fatura
      const desc = (m.descricao || '').toUpperCase();
      if (desc.includes('PAGAMENTO RECEBIDO')) return false;
      if (desc.includes('PAGAMENTO DE FATURA')) return false;
      if (desc.includes('PAGAMENTO FATURA')) return false;

      return true;
    });

    // Converter para formato compativel com parse-pdf
    const transacoes = debitos.map(m => {
      // Converter data de YYYY-MM-DD para DD/MM/YYYY
      let dataFormatada = m.data;
      if (m.data && /^\d{4}-\d{2}-\d{2}$/.test(m.data)) {
        const [ano, mes, dia] = m.data.split('-');
        dataFormatada = `${dia}/${mes}/${ano}`;
      }

      // Extrair parcela se existir no memo
      let parcela = null;
      const parcelaMatch = (m.descricao || '').match(/[Pp]arcela\s+(\d+\/\d+)/);
      if (parcelaMatch) {
        parcela = parcelaMatch[1];
      }
      const parcelaMatch2 = (m.descricao || '').match(/(\d+\/\d+)$/);
      if (!parcela && parcelaMatch2) {
        const parts = parcelaMatch2[1].split('/');
        if (parseInt(parts[0]) <= parseInt(parts[1]) && parseInt(parts[1]) <= 48) {
          parcela = parcelaMatch2[1];
        }
      }

      return {
        data: dataFormatada,
        descricao: m.descricao || '',
        valor: m.valor,
        parcela: parcela
      };
    });

    const valorTotal = transacoes.reduce((sum, t) => sum + (t.valor || 0), 0);

    // Detectar banco pelo OFX
    let bancoDetectado = resultado.banco || 'desconhecido';

    // Verificar se e fatura de cartao (CREDITCARDMSGSRSV1) ou conta (BANKMSGSRSV1)
    const isCreditCard = content.includes('CREDITCARDMSGSRSV1') || content.includes('CCSTMTRS');

    // Tambem verificar FID para Nubank (260)
    const fidMatch = content.match(/<FID>(\d+)/);
    if (fidMatch) {
      const fid = fidMatch[1];
      const bancosPorFid = {
        '260': 'Nubank',
        '341': 'Itau',
        '0341': 'Itau',
        '033': 'Santander',
        '237': 'Bradesco',
        '077': 'Inter',
        '001': 'Banco do Brasil',
        '104': 'Caixa Economica'
      };
      if (bancosPorFid[fid]) {
        bancoDetectado = bancosPorFid[fid];
      }
    }

    // Verificar ORG
    const orgMatch = content.match(/<ORG>([^<\n]+)/i);
    if (orgMatch) {
      const org = orgMatch[1].trim().toUpperCase();
      if (org.includes('NUBANK') || org.includes('NU PAGAMENTOS')) bancoDetectado = 'Nubank';
      else if (org.includes('ITAU')) bancoDetectado = 'Itau';
      else if (org.includes('SANTANDER')) bancoDetectado = 'Santander';
      else if (org.includes('BRADESCO')) bancoDetectado = 'Bradesco';
      else if (org.includes('INTER')) bancoDetectado = 'Inter';
      else if (org.includes('C6')) bancoDetectado = 'C6 Bank';
      else if (org.includes('XP')) bancoDetectado = 'XP';
      else if (org.includes('PICPAY')) bancoDetectado = 'PicPay';
    }

    return NextResponse.json({
      success: true,
      transacoes: transacoes,
      total_encontrado: transacoes.length,
      valor_total: valorTotal,
      banco_detectado: bancoDetectado,
      metodo: 'OFX_PARSER',
      tipo_arquivo: isCreditCard ? 'cartao_credito' : 'conta_corrente'
    });

  } catch (error) {
    console.error('Erro no parse-fatura-ofx:', error);
    return NextResponse.json(
      {
        error: 'Erro ao processar arquivo OFX',
        details: error.message
      },
      { status: 500 }
    );
  }
}

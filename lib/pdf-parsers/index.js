/**
 * Sistema de Parsers de PDF por Banco — v2 Pipeline Registry
 *
 * Detecta automaticamente o banco pelo conteúdo do PDF
 * e retorna o pipeline auto-contido correspondente.
 *
 * Cada pipeline exporta:
 *   extractPipeline(texto, options) → PipelineResult
 *   buildAIPrompt(cartaoNome, tipoCartao, metadados) → string | null
 *   postAICorrections(transacoes, metadados) → transacoes[]
 */

// Re-export utilities for backward compatibility
export {
  parseValorBR,
  parseDataBR,
  extrairParcela,
  calcularAuditoria,
  filtrarTransacoesIA,
  corrigirEstornosIA
} from './utils.js';

// Import pipeline modules
import * as nubankPipeline from './pipelines/nubank.js';
import * as mercadopagoPipeline from './pipelines/mercadopago.js';
import * as c6bankPipeline from './pipelines/c6bank.js';
import * as itauPipeline from './pipelines/itau.js';
import * as santanderPipeline from './pipelines/santander.js';
import * as picpayPipeline from './pipelines/picpay.js';
import * as xpPipeline from './pipelines/xp.js';
import * as rennerPipeline from './pipelines/renner.js';
import * as genericPipeline from './pipelines/generic.js';

/**
 * Registry de pipelines por banco
 */
const PIPELINES = {
  nubank: nubankPipeline,
  mercadopago: mercadopagoPipeline,
  c6bank: c6bankPipeline,
  itau: itauPipeline,
  santander: santanderPipeline,
  picpay: picpayPipeline,
  xp: xpPipeline,
  renner: rennerPipeline,
  bradesco: genericPipeline,
  desconhecido: genericPipeline,
};

/**
 * Retorna o pipeline correspondente ao banco detectado.
 *
 * @param {string} bancoId - ID do banco (retornado por detectarBanco)
 * @returns {{ extractPipeline, buildAIPrompt, postAICorrections, BANK_ID }}
 */
export function getPipeline(bancoId) {
  return PIPELINES[bancoId] || PIPELINES.desconhecido;
}

/**
 * Lista todos os bancos com pipeline registrado.
 */
export function listarBancosSuportados() {
  return Object.keys(PIPELINES);
}

/**
 * Detecta o banco pelo conteúdo do texto extraído do PDF
 */
export function detectarBanco(texto) {
  const textoUpper = texto.toUpperCase();

  // Nubank
  if (textoUpper.includes('NU PAGAMENTOS') ||
      textoUpper.includes('NUBANK') ||
      textoUpper.includes('NU INVEST') ||
      (textoUpper.includes('ROXINHO') && textoUpper.includes('FATURA'))) {
    return 'nubank';
  }

  // Renner / Realize CFI — antes de Santander para evitar falso positivo
  // (faturas Renner podem conter "SANTANDER" em texto legal/transacional,
  //  o que disparava detecção Santander antes de chegar na regra Renner)
  // NOTA: removida keyword genérica "REALIZE" que matchava o verbo
  // português "realize" (de "realizar") em faturas de outros bancos
  if (textoUpper.includes('REALIZE CFI') ||
      textoUpper.includes('REALIZE CREDITO') ||
      textoUpper.includes('REALIZE CRÉDITO') ||
      textoUpper.includes('LOJAS RENNER') ||
      textoUpper.includes('RENNER S.A') ||
      textoUpper.includes('MEU CARTÃO')) {
    return 'renner';
  }

  // Santander — antes de Mercado Pago para evitar falso positivo
  // (faturas Santander podem conter "MERCADOLIVRE" como transação +
  //  "VISA" no nome do cartão, que antes disparava detecção Mercado Pago)
  if (textoUpper.includes('SANTANDER') ||
      textoUpper.includes('BANCO SANTANDER')) {
    return 'santander';
  }

  // Mercado Pago
  // NOTA: removida regra VISA+MERCADO que causava falso positivo
  // em faturas de outros bancos com transações no Mercado Livre
  if (textoUpper.includes('MERCADO PAGO') ||
      textoUpper.includes('MERCADOPAGO') ||
      textoUpper.includes('MERCADO CRÉDITO')) {
    return 'mercadopago';
  }

  // PicPay
  if (textoUpper.includes('PICPAY') ||
      textoUpper.includes('PIC PAY') ||
      textoUpper.includes('PICPAY SERVICOS')) {
    return 'picpay';
  }

  // XP Investimentos
  if (textoUpper.includes('XP INVESTIMENTOS') ||
      textoUpper.includes('XP INC') ||
      textoUpper.includes('CARTÃO XP') ||
      textoUpper.includes('XP VISA') ||
      textoUpper.includes('BANCO XP')) {
    return 'xp';
  }

  // C6 Bank
  if (textoUpper.includes('C6 BANK') ||
      textoUpper.includes('C6 CONSIG') ||
      textoUpper.includes('BANCO C6') ||
      textoUpper.includes('C6 S.A')) {
    return 'c6bank';
  }

  // Itaú
  if (textoUpper.includes('ITAÚ') ||
      textoUpper.includes('ITAU UNIBANCO') ||
      textoUpper.includes('ITAUCARD') ||
      textoUpper.includes('BANCO ITAÚ')) {
    return 'itau';
  }

  // Bradesco
  if (textoUpper.includes('BRADESCO') ||
      textoUpper.includes('BANCO BRADESCO')) {
    return 'bradesco';
  }

  return 'desconhecido';
}

/**
 * Backward-compatible wrapper: processa PDF via pipeline registry.
 *
 * NOTA: Código legado. Novos consumidores devem usar:
 *   const banco = detectarBanco(texto);
 *   const pipeline = getPipeline(banco);
 *   const result = pipeline.extractPipeline(texto);
 *
 * @param {string} texto - Texto extraído do PDF
 * @param {string} bancoHint - Dica opcional do nome do cartão
 * @returns {object|null}
 */
export async function processarPDFDeterministico(texto, bancoHint = '') {
  const banco = detectarBanco(texto + ' ' + bancoHint);
  const pipeline = getPipeline(banco);

  console.log(`[PDF Parser] Banco detectado: ${banco} (pipeline: ${pipeline.BANK_ID})`);

  try {
    const resultado = pipeline.extractPipeline(texto);

    if (!resultado) return null;

    // Mantém shape legado para compatibilidade
    return {
      ...resultado,
      banco_detectado: banco,
      metodo: resultado.metodo || 'PARSER_DETERMINISTICO',
      ...(resultado.auditoria ? { resumo_fatura: resultado.auditoria } : {}),
      ...(resultado.metadados_verificacao ? { metadados_verificacao: resultado.metadados_verificacao } : {}),
      ...(resultado.needsAI ? { confianca_texto: 'baixa' } : {}),
    };
  } catch (error) {
    console.error(`[PDF Parser] Erro no pipeline ${banco}:`, error);
    return null;
  }
}

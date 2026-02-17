/**
 * Dispatcher de parsers determinísticos de extratos bancários (PDF)
 *
 * Cada banco com formato PDF conhecido tem um parser dedicado que extrai
 * movimentações do texto bruto (pdf-parse), sem depender de IA visual.
 */

import { parseExtratoC6Bank } from './c6bank.js';
import { parseExtratoItau } from './itau.js';

const PARSERS = {
  'C6 Bank': parseExtratoC6Bank,
  'Itaú': parseExtratoItau,
};

/**
 * Retorna o parser determinístico para o banco detectado, ou null.
 * @param {string} banco - Nome do banco (ex: "C6 Bank", "Itaú")
 * @returns {function|null}
 */
export function getExtratoParser(banco) {
  return PARSERS[banco] || null;
}

/**
 * Lista de bancos com parser determinístico disponível.
 */
export const BANCOS_COM_PARSER = Object.keys(PARSERS);

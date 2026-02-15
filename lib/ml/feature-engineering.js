/**
 * Feature Engineering para ML de Categorização de Transações
 *
 * Este módulo implementa o pré-processamento de texto e construção
 * de vetores de features para o modelo ONNX. A lógica DEVE ser
 * idêntica ao script Python de treinamento (scripts/ml/train_categorizer.py).
 */

/**
 * Normaliza descrição de transação bancária
 * Remove acentos, uppercase, normaliza prefixos comuns
 */
export function normalizeDescription(text) {
  if (!text) return ''

  let normalized = text
    .toUpperCase()
    .trim()
    // Remove acentos (NFD + strip combining marks)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')

  // Remove números de cartão/conta (sequências de 4+ dígitos)
  normalized = normalized.replace(/\b\d{4,}\b/g, '')

  // Remove datas inline (DD/MM, DD/MM/YYYY)
  normalized = normalized.replace(/\b\d{2}\/\d{2}(\/\d{2,4})?\b/g, '')

  // Normaliza prefixos comuns de gateways de pagamento
  normalized = normalized.replace(/^DL\*/, 'GATEWAY*')
  normalized = normalized.replace(/^MP\s?\*/, 'GATEWAY*')
  normalized = normalized.replace(/^PAG\*/, 'GATEWAY*')
  normalized = normalized.replace(/^IFD\*/, 'GATEWAY*')
  normalized = normalized.replace(/^EC\s?\*/, 'GATEWAY*')
  normalized = normalized.replace(/^EBN\*/, 'GATEWAY*')
  normalized = normalized.replace(/^PG\s?\*/, 'GATEWAY*')
  normalized = normalized.replace(/^PICPAY\*/, 'PICPAY*')

  // Remove espaços extras
  normalized = normalized.replace(/\s+/g, ' ').trim()

  return normalized
}

/**
 * Extrai n-gramas de caracteres de um texto
 * Character n-grams funcionam melhor que word tokens para
 * descrições bancárias abreviadas (ex: "PGTO", "DL*ALIEXPRESS")
 */
export function extractCharNgrams(text, minN = 2, maxN = 4) {
  const ngrams = new Set()
  const padded = ` ${text} ` // padding para capturar limites de palavras

  for (let n = minN; n <= maxN; n++) {
    for (let i = 0; i <= padded.length - n; i++) {
      ngrams.add(padded.substring(i, i + n))
    }
  }

  return ngrams
}

/**
 * Calcula TF (Term Frequency) de n-gramas em um texto
 * Retorna Map<ngram, frequência normalizada>
 */
function computeTF(text, minN = 2, maxN = 4) {
  const counts = new Map()
  const padded = ` ${text} `
  let total = 0

  for (let n = minN; n <= maxN; n++) {
    for (let i = 0; i <= padded.length - n; i++) {
      const ngram = padded.substring(i, i + n)
      counts.set(ngram, (counts.get(ngram) || 0) + 1)
      total++
    }
  }

  // Normalizar
  for (const [key, val] of counts) {
    counts.set(key, val / total)
  }

  return counts
}

/**
 * Constrói vetor de features para inferência ONNX
 *
 * @param {string} descricao - Descrição da transação
 * @param {number} valor - Valor da transação
 * @param {string} banco - Nome do banco
 * @param {object} vocabulary - { terms: string[], idf: number[] } do treinamento
 * @param {string[]} bancosList - Lista de bancos conhecidos (one-hot encoding)
 * @returns {Float32Array} Vetor de features pronto para o modelo
 */
export function buildFeatureVector(descricao, valor, banco, vocabulary, bancosList) {
  const normalized = normalizeDescription(descricao)
  const tf = computeTF(normalized)

  // TF-IDF features (tamanho = vocabulary.terms.length)
  const tfidfSize = vocabulary.terms.length
  const bancosSize = bancosList.length
  const numericSize = 1 // log(valor)

  const featureSize = tfidfSize + bancosSize + numericSize
  const features = new Float32Array(featureSize)

  // 1. TF-IDF
  for (let i = 0; i < vocabulary.terms.length; i++) {
    const term = vocabulary.terms[i]
    const tfVal = tf.get(term) || 0
    features[i] = tfVal * vocabulary.idf[i]
  }

  // 2. Banco (one-hot encoding)
  const bancoNorm = (banco || 'desconhecido').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  const bancoIdx = bancosList.findIndex(b => bancoNorm.includes(b.toUpperCase()))
  if (bancoIdx >= 0) {
    features[tfidfSize + bancoIdx] = 1.0
  }

  // 3. Log(valor) normalizado
  features[tfidfSize + bancosSize] = Math.log1p(Math.abs(valor || 0))

  return features
}

/**
 * Aplica softmax a um array de logits
 * Converte logits em probabilidades (soma = 1)
 */
export function softmax(logits) {
  const maxLogit = Math.max(...logits)
  const exps = logits.map(l => Math.exp(l - maxLogit))
  const sumExps = exps.reduce((a, b) => a + b, 0)
  return exps.map(e => e / sumExps)
}

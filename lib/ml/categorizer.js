/**
 * Motor de Inferência ONNX - Categorização de Transações
 *
 * Carrega modelos ONNX treinados pelo script Python e executa
 * classificação em 2 estágios:
 *   1. PJ vs PF (tipo)
 *   2. Categoria específica (condicionada ao tipo)
 *
 * Modelos são carregados uma vez (cold start ~200ms) e cacheados
 * no module scope para reutilização em warm starts.
 */

import { buildFeatureVector, softmax } from './feature-engineering.js'
import path from 'path'
import fs from 'fs'

// Cache no module scope (sobrevive warm starts no Vercel)
let modelsCache = null
let vocabularyCache = null
let labelMapsCache = null
let loadError = null
let loaded = false

const MODELS_DIR = path.join(process.cwd(), 'lib', 'ml', 'models', 'categorizer')

/**
 * Carrega modelos ONNX e metadados (executado uma vez por cold start)
 */
async function loadModels() {
  if (loaded) return !loadError
  loaded = true

  try {
    // Verificar se os arquivos existem
    const vocabPath = path.join(MODELS_DIR, 'vocabulary.json')
    const labelsPath = path.join(MODELS_DIR, 'label_maps.json')
    const tipoPath = path.join(MODELS_DIR, 'categorizer_tipo.onnx')

    if (!fs.existsSync(vocabPath) || !fs.existsSync(tipoPath)) {
      loadError = 'Modelos ML não encontrados. Execute o treinamento: python scripts/ml/train_categorizer.py'
      console.warn(`[ML] ${loadError}`)
      return false
    }

    // Carregar vocabulário e label maps
    vocabularyCache = JSON.parse(fs.readFileSync(vocabPath, 'utf-8'))
    labelMapsCache = JSON.parse(fs.readFileSync(labelsPath, 'utf-8'))

    // Import dinâmico do onnxruntime-node
    const ort = await import('onnxruntime-node')

    // Carregar modelos ONNX
    modelsCache = {}

    modelsCache.tipo = await ort.InferenceSession.create(tipoPath)

    const pjPath = path.join(MODELS_DIR, 'categorizer_pj.onnx')
    if (fs.existsSync(pjPath)) {
      modelsCache.pj = await ort.InferenceSession.create(pjPath)
    }

    const pfPath = path.join(MODELS_DIR, 'categorizer_pf.onnx')
    if (fs.existsSync(pfPath)) {
      modelsCache.pf = await ort.InferenceSession.create(pfPath)
    }

    console.log(`[ML] Modelos carregados: tipo${modelsCache.pj ? ', pj' : ''}${modelsCache.pf ? ', pf' : ''}`)
    return true
  } catch (err) {
    loadError = `Erro ao carregar modelos ML: ${err.message}`
    console.error(`[ML] ${loadError}`)
    return false
  }
}

/**
 * Executa inferência ONNX para um vetor de features
 * Retorna probabilidades por classe
 */
async function runInference(session, features) {
  const ort = await import('onnxruntime-node')
  const tensor = new ort.Tensor('float32', features, [1, features.length])
  const results = await session.run({ float_input: tensor })

  // O SGDClassifier com log_loss exporta 'label' e 'probabilities'
  // Se exportou com zipmap=false, temos decision_function como output
  const outputNames = Object.keys(results)

  // Tentar pegar probabilidades
  if (results.probabilities) {
    return Array.from(results.probabilities.data)
  }

  // Fallback: usar o último output (geralmente são as probabilidades)
  const lastOutput = results[outputNames[outputNames.length - 1]]
  const data = Array.from(lastOutput.data)

  // Se o output parece ser logits (pode ter valores negativos), aplicar softmax
  if (data.some(v => v < 0)) {
    return softmax(data)
  }

  return data
}

/**
 * Categoriza uma transação usando o modelo ML local
 *
 * @param {string} descricao - Descrição da transação
 * @param {number} valor - Valor da transação
 * @param {string} [banco] - Nome do banco (opcional)
 * @returns {object|null} { tipo, categoria, confianca, alternativas } ou null se ML indisponível
 */
export async function categorizarML(descricao, valor, banco) {
  const ready = await loadModels()
  if (!ready) return null

  try {
    // Construir vetor de features
    const features = buildFeatureVector(
      descricao,
      valor,
      banco,
      vocabularyCache,
      vocabularyCache.bancos
    )

    // Estágio 1: PJ vs PF
    const tipoProbs = await runInference(modelsCache.tipo, features)
    const tipoLabels = labelMapsCache.tipo // ["PF", "PJ"]
    const tipoIdx = tipoProbs.indexOf(Math.max(...tipoProbs))
    const tipo = tipoLabels[tipoIdx]
    const tipoConfianca = tipoProbs[tipoIdx]

    // Estágio 2: Categoria específica
    let categoria = null
    let categoriaConfianca = 0
    let alternativas = []

    const catModel = tipo === 'PJ' ? modelsCache.pj : modelsCache.pf
    const catLabels = tipo === 'PJ' ? labelMapsCache.pj : labelMapsCache.pf

    if (catModel && catLabels && catLabels.length > 0) {
      const catProbs = await runInference(catModel, features)

      // Top 3 categorias com probabilidades
      const catScores = catLabels.map((label, i) => ({
        categoria: label,
        confianca: catProbs[i] || 0
      }))
      catScores.sort((a, b) => b.confianca - a.confianca)

      categoria = catScores[0].categoria
      categoriaConfianca = catScores[0].confianca
      alternativas = catScores.slice(1, 4).filter(s => s.confianca > 0.05)
    }

    // Confiança final = min(tipo, categoria) para ser conservador
    const confianca = Math.min(tipoConfianca, categoriaConfianca)

    return {
      tipo,
      categoria,
      confianca: Math.round(confianca * 1000) / 1000,
      alternativas: alternativas.length > 0 ? alternativas.map(a => ({
        categoria: a.categoria,
        confianca: Math.round(a.confianca * 1000) / 1000
      })) : undefined,
      metodo: 'ml_local'
    }
  } catch (err) {
    console.error(`[ML] Erro na inferência: ${err.message}`)
    return null
  }
}

/**
 * Categoriza um lote de transações
 *
 * @param {Array<{descricao: string, valor: number, banco?: string}>} transacoes
 * @returns {Array<object|null>}
 */
export async function categorizarMLBatch(transacoes) {
  const results = []
  for (const t of transacoes) {
    results.push(await categorizarML(t.descricao, t.valor, t.banco))
  }
  return results
}

/**
 * Verifica se o modelo ML está disponível e carregado
 */
export async function isMLAvailable() {
  const ready = await loadModels()
  return ready
}

/**
 * Retorna informações sobre o modelo carregado
 */
export async function getMLInfo() {
  await loadModels()

  if (loadError) {
    return { available: false, error: loadError }
  }

  const reportPath = path.join(MODELS_DIR, 'training_report.json')
  let report = null
  if (fs.existsSync(reportPath)) {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'))
  }

  return {
    available: true,
    models: {
      tipo: !!modelsCache?.tipo,
      pj: !!modelsCache?.pj,
      pf: !!modelsCache?.pf
    },
    vocabularySize: vocabularyCache?.terms?.length || 0,
    report
  }
}

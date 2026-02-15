'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import MonthPicker from '@/components/MonthPicker'
import DropZone from '@/components/DropZone'
import UploadButton from '@/components/UploadButton'
import ReconciliationCard, { ReconciliationBadge } from '@/components/ReconciliationCard'

const CATEGORY_COLORS = {
  // PJ — cada categoria com cor bem distinta
  'Marketing Digital': 'bg-blue-50 text-blue-700',
  'Pagamento Fornecedores': 'bg-violet-50 text-violet-700',
  'Fretes': 'bg-cyan-50 text-cyan-700',
  'Taxas Checkout': 'bg-amber-50 text-amber-700',
  'Compra de Câmbio': 'bg-lime-50 text-lime-700',
  'IA e Automação': 'bg-indigo-50 text-indigo-700',
  'Design/Ferramentas': 'bg-purple-50 text-purple-700',
  'Telefonia': 'bg-pink-50 text-pink-700',
  'ERP': 'bg-orange-50 text-orange-700',
  'Gestão': 'bg-teal-50 text-teal-700',
  'Viagem Trabalho': 'bg-sky-50 text-sky-700',
  'IOF': 'bg-red-50 text-red-700',
  // Créditos / não-gastos
  'Estorno': 'bg-emerald-50 text-emerald-700',
  'Pagamento Fatura': 'bg-emerald-50 text-emerald-700',
  'Tarifas Cartão': 'bg-stone-50 text-stone-600',
  // PJ outros
  'Outros PJ': 'bg-neutral-100 text-neutral-600 border border-neutral-200',
  'Outros': 'bg-neutral-100 text-neutral-600 border border-neutral-200',
  // PF
  'Pessoal': 'bg-rose-50 text-rose-600',
  'Entretenimento': 'bg-fuchsia-50 text-fuchsia-600',
  'Transporte Pessoal': 'bg-amber-50 text-amber-600',
  'Compras Pessoais': 'bg-purple-50 text-purple-600',
}

export default function UploadPage() {
  const router = useRouter()
  const [step, setStep] = useState(1)
  const [cartoes, setCartoes] = useState([])
  const [categorias, setCategorias] = useState([])
  const [selectedCartao, setSelectedCartao] = useState('')
  const [mesReferencia, setMesReferencia] = useState('')
  const [pdfFile, setPdfFile] = useState(null)
  const [tipoArquivo, setTipoArquivo] = useState('')
  const [transactions, setTransactions] = useState([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [duplicateWarning, setDuplicateWarning] = useState(null)
  const [metodoProcessamento, setMetodoProcessamento] = useState('')
  const [auditoria, setAuditoria] = useState(null)
  const [manualReview, setManualReview] = useState(false)

  useEffect(() => {
    const carregarDados = async () => {
      try {
        const [cartoesRes, categoriasRes] = await Promise.all([
          fetch('/api/cartoes'),
          fetch('/api/categorias')
        ])
        const cartoesData = await cartoesRes.json()
        const categoriasData = await categoriasRes.json()
        setCartoes(cartoesData.cartoes || [])
        setCategorias(categoriasData.categorias || [])
      } catch (err) {
        console.error('Erro ao carregar dados:', err)
      }
    }
    carregarDados()
  }, [])

  const getCartaoNome = () => {
    const cartao = cartoes.find(c => c.id === selectedCartao)
    return cartao ? cartao.nome : ''
  }

  const getCartaoTipo = () => {
    const cartao = cartoes.find(c => c.id === selectedCartao)
    return cartao ? cartao.tipo : ''
  }

  const handleFileChange = (e) => {
    const file = e?.target?.files?.[0] || e
    if (file && file instanceof File) {
      setPdfFile(file)
      const ext = file.name.split('.').pop()?.toLowerCase()
      setTipoArquivo(ext)
    } else {
      setPdfFile(null)
      setTipoArquivo('')
    }
  }

  const handleDropZoneFile = (file) => {
    if (file) {
      setPdfFile(file)
      const ext = file.name.split('.').pop()?.toLowerCase()
      setTipoArquivo(ext)
    } else {
      setPdfFile(null)
      setTipoArquivo('')
    }
  }

  const handleProcessar = async () => {
    if (!pdfFile) { setError('Selecione um arquivo'); return }
    if (!selectedCartao) { setError('Selecione o cartão'); return }
    if (!mesReferencia) { setError('Informe o mês de referência'); return }

    setError('')
    setDuplicateWarning(null)
    setLoading(true)

    try {
      let parsed = []
      let metodo = ''

      const isOFX = tipoArquivo === 'ofx' || tipoArquivo === 'qfx'

      if (isOFX) {
        const formData = new FormData()
        formData.append('file', pdfFile)

        const ofxResponse = await fetch('/api/parse-fatura-ofx', {
          method: 'POST',
          body: formData
        })
        const ofxResult = await ofxResponse.json()

        if (ofxResult.error) {
          throw new Error(ofxResult.error)
        }

        if (!ofxResult.transacoes || ofxResult.transacoes.length === 0) {
          throw new Error('Nenhuma transação encontrada no arquivo OFX')
        }

        parsed = ofxResult.transacoes.map(t => ({
          id: Math.random().toString(36).substr(2, 9),
          data: t.data ? formatarData(t.data) : null,
          descricao: t.descricao,
          valor: parseFloat(t.valor) || 0,
          parcela: t.parcela || null,
          categoria: 'Outros PJ',
          tipo: 'PJ'
        })).filter(t => t.data && t.valor > 0)

        metodo = 'OFX_PARSER'
      } else {
        const formData = new FormData()
        formData.append('pdf', pdfFile)
        formData.append('cartao_nome', getCartaoNome())
        formData.append('tipo_cartao', getCartaoTipo())

        const pdfResponse = await fetch('/api/parse-pdf', {
          method: 'POST',
          body: formData
        })
        const pdfResult = await pdfResponse.json()

        if (pdfResult.error) {
          throw new Error(pdfResult.error)
        }

        if (!pdfResult.transacoes || pdfResult.transacoes.length === 0) {
          throw new Error('Nenhuma transação encontrada no PDF')
        }

        parsed = pdfResult.transacoes.map(t => ({
          id: Math.random().toString(36).substr(2, 9),
          data: t.data ? formatarData(t.data) : null,
          descricao: t.descricao,
          valor: parseFloat(t.valor) || 0,
          parcela: t.parcela || null,
          tipo_lancamento: t.tipo_lancamento || 'compra',
          categoria: 'Outros PJ',
          tipo: 'PJ'
        })).filter(t => t.data && t.valor > 0)

        if (pdfResult.auditoria) {
          setAuditoria(pdfResult.auditoria)
        }

        metodo = pdfResult.metodo || 'IA_PDF'
      }

      if (parsed.length === 0) {
        throw new Error('Nenhuma transação válida encontrada')
      }

      const checkFormData = new FormData()
      checkFormData.append('cartao_id', selectedCartao)
      checkFormData.append('mes_referencia', mesReferencia)
      checkFormData.append('transacoes_preview', JSON.stringify(parsed))

      const checkResponse = await fetch('/api/faturas/check-duplicate', {
        method: 'POST',
        body: checkFormData
      })
      const checkResult = await checkResponse.json()

      if (checkResult.duplicada) {
        setDuplicateWarning({
          message: checkResult.message,
          fatura_id: checkResult.fatura_existente_id,
          similaridade: checkResult.similaridade,
          valor_existente: checkResult.valor_existente
        })
        setTransactions(parsed)
        setMetodoProcessamento(metodo)
        setLoading(false)
        return
      }

      await categorizarEAvancar(parsed, metodo)
    } catch (err) {
      setError(`Erro: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  const categorizarEAvancar = async (parsed, metodo) => {
    const response = await fetch('/api/categorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transacoes: parsed,
        tipo_cartao: getCartaoTipo()
      })
    })
    const result = await response.json()

    if (result.resultados?.length > 0) {
      setTransactions(parsed.map((t, i) => ({
        ...t,
        categoria: result.resultados[i]?.categoria || 'Outros PJ',
        tipo: result.resultados[i]?.incluir === false ? 'PF' : 'PJ'
      })))
    } else {
      setTransactions(parsed)
    }
    setMetodoProcessamento(metodo)
    setStep(2)
  }

  const handleContinuarMesmoAssim = async () => {
    setDuplicateWarning(null)
    setLoading(true)

    try {
      if (transactions.length > 0) {
        await categorizarEAvancar(transactions, metodoProcessamento)
      } else {
        await handleProcessar()
      }
    } catch (err) {
      setError(`Erro: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  const formatarData = (dataStr) => {
    if (!dataStr) return null

    if (/^\d{4}-\d{2}-\d{2}$/.test(dataStr)) {
      return dataStr
    }

    const match = dataStr.match(/(\d{2})\/(\d{2})\/(\d{4})/)
    if (match) {
      const [, dia, mes, ano] = match
      return `${ano}-${mes}-${dia}`
    }

    const matchSemAno = dataStr.match(/(\d{2})\/(\d{2})/)
    if (matchSemAno && mesReferencia) {
      const [, dia, mes] = matchSemAno
      const [ano] = mesReferencia.split('-')
      return `${ano}-${mes}-${dia}`
    }

    return null
  }

  const handleSalvar = async () => {
    setSaving(true)
    setError('')
    try {
      const faturaRes = await fetch('/api/faturas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cartao_id: selectedCartao,
          mes_referencia: `${mesReferencia}-01`,
          status: 'pendente'
        })
      })
      const faturaResult = await faturaRes.json()
      if (faturaResult.error) throw new Error(faturaResult.error)

      if (pdfFile) {
        const arquivoFormData = new FormData()
        arquivoFormData.append('fatura_id', faturaResult.fatura.id)
        arquivoFormData.append('arquivo', pdfFile)

        const uploadRes = await fetch('/api/faturas/upload-pdf', {
          method: 'POST',
          body: arquivoFormData
        })
        const uploadResult = await uploadRes.json()
        if (uploadResult.error) {
          console.warn('Aviso: Arquivo não foi salvo -', uploadResult.error)
        }
      }

      if (process.env.NODE_ENV === 'development') {
        console.log(`[upload] Salvando fatura: manualReview=${manualReview}`)
      }

      const transacoesRes = await fetch('/api/transacoes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fatura_id: faturaResult.fatura.id,
          transacoes: transactions.map(t => ({
            data: t.data, descricao: t.descricao, valor: t.valor,
            categoria: t.categoria, tipo: t.tipo,
            metodo: (manualReview || t._editadoManualmente) ? 'manual' : 'automatico',
            tipo_lancamento: t.tipo_lancamento || 'compra'
          })),
          auditoria: auditoria || null
        })
      })
      const transacoesResult = await transacoesRes.json()
      if (transacoesResult.error) throw new Error(transacoesResult.error)

      setSuccess(`Fatura salva com ${transacoesResult.quantidade} transações!`)
      setTimeout(() => router.push('/faturas'), 2000)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const updateTransaction = (id, field, value) => {
    setTransactions(prev => prev.map(t => {
      if (t.id === id) {
        const updated = { ...t, [field]: value, _editadoManualmente: true }
        if (field === 'categoria' && ['Pessoal', 'Tarifas Cartão', 'Entretenimento', 'Transporte Pessoal', 'Compras Pessoais'].includes(value)) {
          updated.tipo = 'PF'
        }
        return updated
      }
      return t
    }))
  }

  const gastosContaveis = transactions.filter(t => {
    const tipo = t.tipo_lancamento || 'compra'
    return tipo === 'compra' || tipo === 'iof'
  })
  const totalPJ = gastosContaveis.filter(t => t.tipo === 'PJ').reduce((a, t) => a + t.valor, 0)
  const totalPF = gastosContaveis.filter(t => t.tipo === 'PF').reduce((a, t) => a + t.valor, 0)

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-page-title text-neutral-900">Importar fatura</h1>
        <p className="text-body text-neutral-500">Passo {step} de 2</p>
      </div>

      {error && <div className="p-3 bg-rose-50 border border-neutral-200 rounded-lg text-rose-700 text-[13px]">{error}</div>}
      {success && <div className="p-3 bg-emerald-50 border border-neutral-200 rounded-lg text-emerald-700 text-[13px]">{success}</div>}

      {duplicateWarning && (
        <div className="p-4 bg-amber-50 border border-neutral-200 rounded-lg">
          <h3 className="text-[13px] font-medium text-amber-800 mb-2">Fatura possivelmente duplicada</h3>
          <p className="text-[13px] text-amber-700 mb-3">{duplicateWarning.message}</p>
          {duplicateWarning.valor_existente && (
            <p className="text-label text-amber-600 mb-3">
              Valor da fatura existente: R$ {parseFloat(duplicateWarning.valor_existente).toLocaleString('pt-BR', {minimumFractionDigits: 2})}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setDuplicateWarning(null)}
              className="px-3 py-1.5 bg-white border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 text-[13px]"
            >
              Cancelar
            </button>
            <button
              onClick={handleContinuarMesmoAssim}
              className="px-3 py-1.5 bg-amber-600 text-white rounded-lg hover:bg-amber-700 text-[13px] font-medium"
            >
              Continuar mesmo assim
            </button>
            <a
              href={`/faturas/${duplicateWarning.fatura_id}`}
              className="px-3 py-1.5 bg-neutral-900 text-white rounded-lg hover:bg-neutral-800 text-[13px] font-medium"
            >
              Ver fatura existente
            </a>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="bg-white rounded-lg border border-neutral-200 p-5 md:p-6 space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-label font-medium mb-1.5 text-neutral-500">Cartão *</label>
              <select value={selectedCartao} onChange={(e) => setSelectedCartao(e.target.value)}
                className="w-full p-2.5 border border-neutral-200 rounded-lg bg-white text-neutral-900 text-[13px] focus:border-neutral-400 focus:ring-2 focus:ring-neutral-200 focus:outline-none">
                <option value="">Selecione o cartão...</option>
                {cartoes.map(c => <option key={c.id} value={c.id}>{c.nome} ({c.tipo})</option>)}
              </select>
            </div>
            <MonthPicker
              value={mesReferencia}
              onChange={setMesReferencia}
              label="Mês de referência"
              required
            />
          </div>

          <DropZone
            onFileSelect={handleDropZoneFile}
            accept=".pdf,.ofx,.qfx"
            file={pdfFile}
            formats={[
              { ext: '.OFX', label: 'Recomendado', color: 'bg-emerald-50 text-emerald-700' },
              { ext: '.PDF', label: 'usa IA', color: 'bg-amber-50 text-amber-700' },
            ]}
          />

          <p className="text-label text-neutral-400 text-center">
            Suporta faturas de Nubank, Itaú, Santander, C6 Bank, Mercado Pago, PicPay, Renner, XP e outros.
          </p>

          <div className="flex justify-center">
            <UploadButton
              onClick={handleProcessar}
              loading={loading}
              disabled={!selectedCartao || !mesReferencia || !pdfFile}
              label="Processar fatura"
            />
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div className="bg-white rounded-lg border border-neutral-200 p-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <p className="text-[13px] text-neutral-500">{transactions.length} transações encontradas</p>
                {metodoProcessamento === 'OFX_PARSER' && (
                  <span className="px-1.5 py-0.5 bg-neutral-100 text-neutral-600 text-[11px] rounded font-medium">
                    OFX
                  </span>
                )}
                {metodoProcessamento === 'PARSER_DETERMINISTICO' && (
                  <span className="px-1.5 py-0.5 bg-neutral-100 text-neutral-600 text-[11px] rounded font-medium">
                    Parser
                  </span>
                )}
                {metodoProcessamento === 'IA_PDF' && (
                  <span className="px-1.5 py-0.5 bg-amber-50 text-amber-700 text-[11px] rounded font-medium">
                    IA
                  </span>
                )}
                {metodoProcessamento === 'IA_PDF_HIBRIDO' && (
                  <span className="px-1.5 py-0.5 bg-indigo-50 text-indigo-700 text-[11px] rounded font-medium">
                    IA Híbrido
                  </span>
                )}
                <ReconciliationBadge auditoria={auditoria} />
              </div>
              <div className="flex items-center gap-3 text-[13px] font-medium">
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  <span className="text-neutral-900">PJ: R$ {totalPJ.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</span>
                </div>
                <span className="text-neutral-300">|</span>
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                  <span className="text-neutral-900">PF: R$ {totalPF.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</span>
                </div>
              </div>
            </div>
            <button onClick={() => setStep(1)} className="text-neutral-500 hover:text-neutral-900 text-[13px]">← Voltar</button>
          </div>

          {auditoria && <ReconciliationCard auditoria={auditoria} />}

          <div className="bg-white rounded-lg border border-neutral-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-neutral-50">
                  <tr>
                    <th className="py-2 px-3 text-left text-[11px] uppercase tracking-wider font-medium text-neutral-400">Data</th>
                    <th className="py-2 px-3 text-left text-[11px] uppercase tracking-wider font-medium text-neutral-400">Descrição</th>
                    <th className="py-2 px-3 text-left text-[11px] uppercase tracking-wider font-medium text-neutral-400">Categoria</th>
                    <th className="py-2 px-3 text-center text-[11px] uppercase tracking-wider font-medium text-neutral-400">Tipo</th>
                    <th className="py-2 px-3 text-right text-[11px] uppercase tracking-wider font-medium text-neutral-400">Valor</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {transactions.map(t => (
                    <tr key={t.id} className="hover:bg-neutral-50">
                      <td className="py-2 px-3 font-mono text-[11px] text-neutral-500">{t.data ? new Date(t.data + 'T12:00:00').toLocaleDateString('pt-BR') : '-'}</td>
                      <td className="py-2 px-3 max-w-xs truncate text-[13px] text-neutral-900" title={t.descricao}>{t.descricao}</td>
                      <td className="py-2 px-3">
                        <select value={t.categoria} onChange={(e) => updateTransaction(t.id, 'categoria', e.target.value)}
                          className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${CATEGORY_COLORS[t.categoria] || 'bg-neutral-100 text-neutral-600'}`}>
                          {categorias.map(c => <option key={c.id} value={c.nome}>{c.nome}</option>)}
                        </select>
                      </td>
                      <td className="py-2 px-3 text-center">
                        <select value={t.tipo} onChange={(e) => updateTransaction(t.id, 'tipo', e.target.value)}
                          className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${t.tipo === 'PJ' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-600'}`}>
                          <option value="PJ">PJ</option>
                          <option value="PF">PF</option>
                        </select>
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-[13px] font-medium text-neutral-900">R$ {t.valor.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <label className="flex items-start gap-2.5 cursor-pointer group">
              <input
                type="checkbox"
                checked={manualReview}
                onChange={(e) => setManualReview(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-500"
              />
              <span className="select-none">
                <span className="text-[13px] font-medium text-neutral-700 group-hover:text-neutral-900">
                  Revisão manual
                </span>
                <span className="block text-[11px] text-neutral-400 mt-0.5 leading-tight">
                  Marca todas as transações como MANUAL para treinamento do ML.
                  Use quando você revisou e confirmou cada categoria.
                </span>
              </span>
            </label>

            <button onClick={handleSalvar} disabled={saving}
              className="px-4 py-2 bg-neutral-900 text-white rounded-lg hover:bg-neutral-800 disabled:opacity-50 text-[13px] font-medium transition-colors whitespace-nowrap">
              {saving ? (
                <span className="flex items-center gap-2">
                  <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></span>
                  Salvando...
                </span>
              ) : 'Salvar fatura'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

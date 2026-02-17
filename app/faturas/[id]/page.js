'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Trash2, Download, Search, X, FileText, CheckSquare, Square, File, Calendar } from 'lucide-react'
import ConfirmModal from '@/components/ConfirmModal'
import DatePicker from '@/components/DatePicker'
import MonthPicker from '@/components/MonthPicker'

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
  'Outros PJ': 'bg-neutral-100 text-neutral-600',
  'Outros': 'bg-neutral-100 text-neutral-600',
  // PF
  'Pessoal': 'bg-rose-50 text-rose-600',
  'Entretenimento': 'bg-fuchsia-50 text-fuchsia-600',
  'Transporte Pessoal': 'bg-amber-50 text-amber-600',
  'Compras Pessoais': 'bg-purple-50 text-purple-600',
}

export default function FaturaDetalhesPage() {
  const params = useParams()
  const router = useRouter()
  const [fatura, setFatura] = useState(null)
  const [transacoes, setTransacoes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Filtros
  const [busca, setBusca] = useState('')
  const [filtroTipo, setFiltroTipo] = useState('')

  // Seleção
  const [selectedIds, setSelectedIds] = useState(new Set())

  // Categorias
  const [categorias, setCategorias] = useState([])

  // Modals
  const [deleteModal, setDeleteModal] = useState({ open: false, transacao: null, multiple: false })
  const [loadingAction, setLoadingAction] = useState(false)

  useEffect(() => {
    const carregarDados = async () => {
      try {
        const faturaRes = await fetch(`/api/faturas?id=${params.id}`)
        const faturaData = await faturaRes.json()
        if (faturaData.error) throw new Error(faturaData.error)
        setFatura(faturaData.fatura)

        const transacoesRes = await fetch(`/api/transacoes?fatura_id=${params.id}`)
        const transacoesData = await transacoesRes.json()
        if (transacoesData.error) throw new Error(transacoesData.error)
        setTransacoes(transacoesData.transacoes || [])

        const categoriasRes = await fetch('/api/categorias')
        const categoriasData = await categoriasRes.json()
        setCategorias(categoriasData.categorias || [])
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }

    if (params.id) {
      carregarDados()
    }
  }, [params.id])

  const formatCurrency = (value) => {
    return (parseFloat(value) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }

  const formatDate = (date) => {
    if (!date) return '-'
    return new Date(date + 'T12:00:00').toLocaleDateString('pt-BR')
  }

  // Filtrar transações
  const transacoesFiltradas = transacoes.filter(t => {
    if (filtroTipo && t.tipo !== filtroTipo) return false
    if (busca && !t.descricao.toLowerCase().includes(busca.toLowerCase())) return false
    return true
  })

  // Seleção
  const toggleSelection = (id) => {
    const newSet = new Set(selectedIds)
    if (newSet.has(id)) {
      newSet.delete(id)
    } else {
      newSet.add(id)
    }
    setSelectedIds(newSet)
  }

  const selectAll = () => {
    if (selectedIds.size === transacoesFiltradas.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(transacoesFiltradas.map(t => t.id)))
    }
  }

  // Handlers
  const handleDeleteSingle = (transacao) => {
    setDeleteModal({ open: true, transacao, multiple: false })
  }

  const handleDeleteMultiple = () => {
    if (selectedIds.size === 0) return
    setDeleteModal({ open: true, transacao: null, multiple: true })
  }

  const handleConfirmDelete = async () => {
    setLoadingAction(true)
    try {
      if (deleteModal.multiple) {
        const res = await fetch(`/api/transacoes?ids=${Array.from(selectedIds).join(',')}`, { method: 'DELETE' })
        const result = await res.json()
        if (result.error) throw new Error(result.error)
        setTransacoes(prev => prev.filter(t => !selectedIds.has(t.id)))
        setSelectedIds(new Set())
      } else {
        const res = await fetch(`/api/transacoes?id=${deleteModal.transacao.id}`, { method: 'DELETE' })
        const result = await res.json()
        if (result.error) throw new Error(result.error)
        setTransacoes(prev => prev.filter(t => t.id !== deleteModal.transacao.id))
        selectedIds.delete(deleteModal.transacao.id)
        setSelectedIds(new Set(selectedIds))
      }
      setDeleteModal({ open: false, transacao: null, multiple: false })
    } catch (err) {
      alert('Erro ao remover: ' + err.message)
    } finally {
      setLoadingAction(false)
    }
  }

  const handleUpdateCategoria = async (transacaoId, novaCategoria) => {
    try {
      const res = await fetch('/api/transacoes', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: transacaoId, categoria: novaCategoria })
      })
      const result = await res.json()
      if (result.error) throw new Error(result.error)
      setTransacoes(prev => prev.map(t => t.id === transacaoId ? { ...t, categoria: novaCategoria } : t))
    } catch (err) {
      alert('Erro ao atualizar categoria: ' + err.message)
    }
  }

  const handleUpdateTipo = async (transacaoId, novoTipo) => {
    try {
      const res = await fetch('/api/transacoes', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: transacaoId, tipo: novoTipo })
      })
      const result = await res.json()
      if (result.error) throw new Error(result.error)
      setTransacoes(prev => prev.map(t => t.id === transacaoId ? { ...t, tipo: novoTipo } : t))
    } catch (err) {
      alert('Erro ao atualizar tipo: ' + err.message)
    }
  }

  const handleUpdateData = async (campo, valor) => {
    try {
      const res = await fetch('/api/faturas', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: params.id, [campo]: valor })
      })
      const result = await res.json()
      if (result.error) throw new Error(result.error)
      setFatura(prev => ({ ...prev, [campo]: valor }))
    } catch (err) {
      alert('Erro ao atualizar data: ' + err.message)
    }
  }

  const handleDownloadArquivo = () => {
    if (fatura?.pdf_url) {
      // Cria um link temporário para download
      const link = document.createElement('a')
      link.href = fatura.pdf_url
      link.download = fatura.arquivo_nome || `fatura-${fatura.id}.pdf`
      link.target = '_blank'
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    }
  }

  const handleOpenPDF = () => {
    if (fatura?.pdf_url) {
      window.open(fatura.pdf_url, '_blank')
    }
  }

  // Detecta o tipo do arquivo
  const getArquivoInfo = () => {
    if (!fatura?.pdf_url) return null
    const tipo = fatura.arquivo_tipo || (fatura.pdf_url.includes('.ofx') ? 'ofx' : fatura.pdf_url.includes('.qfx') ? 'qfx' : 'pdf')
    const nome = fatura.arquivo_nome || `fatura.${tipo}`
    return { tipo: tipo.toUpperCase(), nome }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-neutral-300 border-t-neutral-900"></div>
      </div>
    )
  }

  if (error || !fatura) {
    return (
      <div className="space-y-4">
        <Link href="/faturas" className="text-neutral-500 hover:text-neutral-900 text-sm">← Voltar para faturas</Link>
        <div className="bg-rose-50 border border-neutral-200 rounded-lg p-6 text-center">
          <h2 className="text-lg font-semibold text-rose-800">Erro ao carregar fatura</h2>
          <p className="text-rose-600 mt-1">{error || 'Fatura não encontrada'}</p>
        </div>
      </div>
    )
  }

  const totalPJ = transacoesFiltradas.filter(t => t.tipo === 'PJ').reduce((a, t) => a + parseFloat(t.valor || 0), 0)
  const totalPF = transacoesFiltradas.filter(t => t.tipo === 'PF').reduce((a, t) => a + parseFloat(t.valor || 0), 0)

  const deleteMessage = deleteModal.multiple
    ? `Tem certeza que deseja remover ${selectedIds.size} transações selecionadas? Esta ação não pode ser desfeita.`
    : `Tem certeza que deseja remover "${deleteModal.transacao?.descricao}"? Esta ação não pode ser desfeita.`

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <Link href="/faturas" className="text-neutral-500 hover:text-neutral-900 text-sm">← Voltar para faturas</Link>
          <h1 className="text-2xl font-semibold text-neutral-900 mt-1">
            {fatura.cartoes?.nome || 'Fatura'}
          </h1>
          <p className="text-neutral-500">
            {new Date(fatura.mes_referencia).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* Botao de Download de Arquivo - Destaque */}
          {fatura?.pdf_url && (
            <button
              onClick={handleDownloadArquivo}
              className="px-4 py-2 bg-neutral-900 text-white rounded-lg hover:bg-neutral-800 text-sm flex items-center gap-2 font-medium"
            >
              <Download size={16} />
              Baixar arquivo {getArquivoInfo()?.tipo && `(${getArquivoInfo().tipo})`}
            </button>
          )}
          {selectedIds.size > 0 && (
            <button
              onClick={handleDeleteMultiple}
              className="px-3 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 text-sm flex items-center gap-2"
            >
              <Trash2 size={16} />
              Remover {selectedIds.size} selecionadas
            </button>
          )}
          {fatura?.pdf_url && (
            <button
              onClick={handleOpenPDF}
              className="px-3 py-2 text-neutral-600 bg-white border border-neutral-200 rounded-lg hover:bg-neutral-50 text-sm flex items-center gap-2"
            >
              <FileText size={16} />
              Visualizar
            </button>
          )}
        </div>
      </div>

      {/* Datas da fatura */}
      <div className="bg-white rounded-lg border border-neutral-200 p-4 flex flex-wrap gap-6 items-center">
        <div className="flex items-center gap-2">
          <Calendar size={14} strokeWidth={1.5} className="text-neutral-400" />
          <span className="text-[12px] text-neutral-400 uppercase tracking-wider font-medium">Mês Ref.</span>
          <MonthPicker
            value={fatura.mes_referencia ? fatura.mes_referencia.substring(0, 7) : null}
            onChange={(val) => handleUpdateData('mes_referencia', val ? val + '-01' : null)}
            placeholder="Definir mês"
            label={null}
            inline
          />
        </div>
        <div className="w-px h-5 bg-neutral-200 hidden sm:block" />
        <div className="flex items-center gap-2">
          <Calendar size={14} strokeWidth={1.5} className="text-neutral-400" />
          <span className="text-[12px] text-neutral-400 uppercase tracking-wider font-medium">Fechamento</span>
          <DatePicker
            value={fatura.data_fechamento || null}
            onChange={(val) => handleUpdateData('data_fechamento', val)}
            placeholder="Definir data"
            inline
          />
        </div>
        <div className="w-px h-5 bg-neutral-200 hidden sm:block" />
        <div className="flex items-center gap-2">
          <Calendar size={14} strokeWidth={1.5} className="text-neutral-400" />
          <span className="text-[12px] text-neutral-400 uppercase tracking-wider font-medium">Vencimento</span>
          <DatePicker
            value={fatura.data_vencimento || null}
            onChange={(val) => handleUpdateData('data_vencimento', val)}
            placeholder="Definir data"
            inline
          />
        </div>
      </div>

      {/* Totais */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-lg border border-neutral-200 p-5">
          <p className="text-sm font-medium text-neutral-500">Total da fatura</p>
          <p className="text-2xl font-semibold text-neutral-900 mt-1">R$ {formatCurrency(totalPJ + totalPF)}</p>
          <p className="text-xs text-neutral-400 mt-1">{transacoesFiltradas.length} transações</p>
        </div>
        <div className="bg-emerald-50 rounded-lg border border-neutral-200 p-5">
          <p className="text-sm font-medium text-emerald-600">Total PJ (reembolsável)</p>
          <p className="text-2xl font-semibold text-emerald-700 mt-1">R$ {formatCurrency(totalPJ)}</p>
        </div>
        <div className="bg-rose-50 rounded-lg border border-neutral-200 p-5">
          <p className="text-sm font-medium text-rose-600">Total PF (pessoal)</p>
          <p className="text-2xl font-semibold text-rose-700 mt-1">R$ {formatCurrency(totalPF)}</p>
        </div>
      </div>

      {/* Filtros */}
      <div className="bg-white rounded-lg border border-neutral-200 p-4 flex flex-wrap gap-4 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={18} />
          <input
            type="text"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar por descrição..."
            className="w-full pl-10 pr-4 py-2 border border-neutral-200 rounded-lg text-sm focus:border-neutral-400 focus:ring-2 focus:ring-neutral-100"
          />
          {busca && (
            <button onClick={() => setBusca('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600">
              <X size={16} />
            </button>
          )}
        </div>
        <select
          value={filtroTipo}
          onChange={(e) => setFiltroTipo(e.target.value)}
          className="px-3 py-2 border border-neutral-200 rounded-lg text-sm bg-white focus:border-neutral-400"
        >
          <option value="">Todos os tipos</option>
          <option value="PJ">PJ (empresarial)</option>
          <option value="PF">PF (pessoal)</option>
        </select>
      </div>

      {/* Lista de Transacoes */}
      <div className="bg-white rounded-lg border border-neutral-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 border-b border-neutral-200">
              <tr>
                <th className="p-3 text-center w-12">
                  <button onClick={selectAll} className="text-neutral-400 hover:text-neutral-600">
                    {selectedIds.size === transacoesFiltradas.length && transacoesFiltradas.length > 0 ? <CheckSquare size={18} /> : <Square size={18} />}
                  </button>
                </th>
                <th className="p-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Data</th>
                <th className="p-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Descrição</th>
                <th className="p-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Categoria</th>
                <th className="p-3 text-center text-xs font-medium text-neutral-500 uppercase tracking-wider">Tipo</th>
                <th className="p-3 text-right text-xs font-medium text-neutral-500 uppercase tracking-wider">Valor</th>
                <th className="p-3 text-center w-12"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {transacoesFiltradas.map(t => (
                <tr key={t.id} className={`hover:bg-neutral-50 ${t.tipo === 'PF' ? 'bg-rose-50/30' : ''} ${selectedIds.has(t.id) ? 'bg-neutral-100' : ''}`}>
                  <td className="p-3 text-center">
                    <button onClick={() => toggleSelection(t.id)} className="text-neutral-400 hover:text-neutral-600">
                      {selectedIds.has(t.id) ? <CheckSquare size={18} className="text-neutral-900" /> : <Square size={18} />}
                    </button>
                  </td>
                  <td className="p-3 font-mono text-xs text-neutral-600">{formatDate(t.data)}</td>
                  <td className="p-3 max-w-xs">
                    <span className="truncate block text-neutral-900" title={t.descricao}>{t.descricao}</span>
                  </td>
                  <td className="p-3">
                    <select
                      value={t.categoria || 'Outros'}
                      onChange={(e) => handleUpdateCategoria(t.id, e.target.value)}
                      className={`px-2 py-1 rounded text-xs font-medium cursor-pointer appearance-none bg-transparent ${CATEGORY_COLORS[t.categoria] || 'bg-neutral-100 text-neutral-600'}`}
                    >
                      {categorias.map(c => (
                        <option key={c.id} value={c.nome}>{c.nome}</option>
                      ))}
                      {!categorias.find(c => c.nome === t.categoria) && t.categoria && (
                        <option value={t.categoria}>{t.categoria}</option>
                      )}
                    </select>
                  </td>
                  <td className="p-3 text-center">
                    <select
                      value={t.tipo}
                      onChange={(e) => handleUpdateTipo(t.id, e.target.value)}
                      className={`px-2 py-0.5 rounded text-xs font-medium cursor-pointer appearance-none bg-transparent ${t.tipo === 'PJ' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-600'}`}
                    >
                      <option value="PJ">PJ</option>
                      <option value="PF">PF</option>
                    </select>
                  </td>
                  <td className="p-3 text-right font-mono font-medium text-neutral-900">
                    R$ {formatCurrency(t.valor)}
                  </td>
                  <td className="p-3 text-center">
                    <button
                      onClick={() => handleDeleteSingle(t)}
                      className="p-1.5 text-neutral-400 hover:text-rose-500 hover:bg-rose-50 rounded transition-colors"
                      title="Remover transação"
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Delete Modal */}
      <ConfirmModal
        isOpen={deleteModal.open}
        onClose={() => setDeleteModal({ open: false, transacao: null, multiple: false })}
        onConfirm={handleConfirmDelete}
        title={deleteModal.multiple ? `Remover ${selectedIds.size} transações` : 'Remover transação'}
        message={deleteMessage}
        confirmText="Remover"
        variant="danger"
        loading={loadingAction}
      />

    </div>
  )
}

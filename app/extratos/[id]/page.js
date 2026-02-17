'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Trash2, Search, X, FileText, CheckSquare, Square, ArrowLeft, TrendingUp, TrendingDown } from 'lucide-react'
import ConfirmModal from '@/components/ConfirmModal'

const CATEGORY_COLORS = {
  'Receitas': 'bg-emerald-50 text-emerald-700',
  'Vendas Online': 'bg-emerald-50 text-emerald-700',
  'Reembolso Sócio': 'bg-blue-50 text-blue-700',
  'Funcionários': 'bg-violet-50 text-violet-700',
  'Impostos': 'bg-rose-50 text-rose-700',
  'Fretes': 'bg-cyan-50 text-cyan-700',
  'Marketing Digital': 'bg-indigo-50 text-indigo-700',
  'Fornecedores': 'bg-purple-50 text-purple-700',
  'Aluguel': 'bg-orange-50 text-orange-700',
  'Tarifas Bancárias': 'bg-neutral-100 text-neutral-600',
  'Outros': 'bg-neutral-100 text-neutral-600',
}

export default function ExtratoDetalhesPage() {
  const params = useParams()
  const router = useRouter()
  const [extrato, setExtrato] = useState(null)
  const [movimentacoes, setMovimentacoes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Filtros
  const [busca, setBusca] = useState('')
  const [filtroTipo, setFiltroTipo] = useState('')

  // Seleção
  const [selectedIds, setSelectedIds] = useState(new Set())

  // Modals
  const [deleteModal, setDeleteModal] = useState({ open: false, movimentacao: null, multiple: false })
  const [loadingAction, setLoadingAction] = useState(false)

  useEffect(() => {
    const carregarDados = async () => {
      try {
        // Buscar extrato
        const extratoRes = await fetch(`/api/extratos?limit=100`)
        const extratoData = await extratoRes.json()
        const extratoEncontrado = (extratoData.extratos || []).find(e => e.id === params.id)

        if (!extratoEncontrado) {
          setError('Extrato não encontrado')
          setLoading(false)
          return
        }

        setExtrato(extratoEncontrado)

        // Buscar movimentações
        const movRes = await fetch(`/api/movimentacoes?extrato_id=${params.id}`)
        const movData = await movRes.json()
        if (movData.error) throw new Error(movData.error)
        setMovimentacoes(movData.movimentacoes || [])
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

  const handleUpdateCategoria = async (movimentacaoId, novaCategoria) => {
    try {
      const res = await fetch('/api/movimentacoes', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: movimentacaoId, categoria: novaCategoria })
      })
      const result = await res.json()
      if (result.error) throw new Error(result.error)
      setMovimentacoes(prev => prev.map(m => m.id === movimentacaoId ? { ...m, categoria: novaCategoria } : m))
    } catch (err) {
      alert('Erro ao atualizar categoria: ' + err.message)
    }
  }

  const formatCurrency = (value) => {
    return (parseFloat(value) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }

  const formatDate = (date) => {
    if (!date) return '-'
    return new Date(date + 'T12:00:00').toLocaleDateString('pt-BR')
  }

  // Filtrar movimentações
  const movimentacoesFiltradas = movimentacoes.filter(m => {
    if (filtroTipo && m.tipo !== filtroTipo) return false
    if (busca && !m.descricao.toLowerCase().includes(busca.toLowerCase())) return false
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
    if (selectedIds.size === movimentacoesFiltradas.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(movimentacoesFiltradas.map(m => m.id)))
    }
  }

  const handleDeleteSingle = (movimentacao) => {
    setDeleteModal({ open: true, movimentacao, multiple: false })
  }

  const handleDeleteMultiple = () => {
    if (selectedIds.size === 0) return
    setDeleteModal({ open: true, movimentacao: null, multiple: true })
  }

  const handleConfirmDelete = async () => {
    setLoadingAction(true)
    try {
      if (deleteModal.multiple) {
        const res = await fetch(`/api/movimentacoes?ids=${Array.from(selectedIds).join(',')}`, { method: 'DELETE' })
        const result = await res.json()
        if (result.error) throw new Error(result.error)
        setMovimentacoes(prev => prev.filter(m => !selectedIds.has(m.id)))
        setSelectedIds(new Set())
      } else {
        const res = await fetch(`/api/movimentacoes?id=${deleteModal.movimentacao.id}`, { method: 'DELETE' })
        const result = await res.json()
        if (result.error) throw new Error(result.error)
        setMovimentacoes(prev => prev.filter(m => m.id !== deleteModal.movimentacao.id))
        selectedIds.delete(deleteModal.movimentacao.id)
        setSelectedIds(new Set(selectedIds))
      }
      setDeleteModal({ open: false, movimentacao: null, multiple: false })
    } catch (err) {
      alert('Erro ao remover: ' + err.message)
    } finally {
      setLoadingAction(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-neutral-500"></div>
      </div>
    )
  }

  if (error || !extrato) {
    return (
      <div className="bg-rose-50 border border-neutral-200 rounded-lg p-6 text-center">
        <h2 className="text-lg font-bold text-rose-800">Erro ao carregar extrato</h2>
        <p className="text-rose-600 mt-1">{error || 'Extrato não encontrado'}</p>
        <Link href="/extratos" className="inline-block mt-4 text-rose-600 hover:underline">
          ← Voltar para extratos
        </Link>
      </div>
    )
  }

  const totalEntradas = movimentacoesFiltradas.filter(m => m.tipo === 'entrada').reduce((a, m) => a + parseFloat(m.valor || 0), 0)
  const totalSaidas = movimentacoesFiltradas.filter(m => m.tipo === 'saida').reduce((a, m) => a + parseFloat(m.valor || 0), 0)

  const deleteMessage = deleteModal.multiple
    ? `Tem certeza que deseja remover ${selectedIds.size} movimentações selecionadas? Esta ação não pode ser desfeita.`
    : `Tem certeza que deseja remover "${deleteModal.movimentacao?.descricao}"? Esta ação não pode ser desfeita.`

  return (
    <div className="space-y-6">
      {/* Cabeçalho */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <Link href="/extratos" className="text-neutral-500 hover:text-neutral-700 text-sm flex items-center gap-1 mb-2">
            <ArrowLeft size={14} /> Voltar para extratos
          </Link>
          <h1 className="text-2xl font-bold text-neutral-800">{extrato.banco}</h1>
          <p className="text-neutral-500">
            {extrato.mes_referencia ? new Date(extrato.mes_referencia).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }) : '-'}
          </p>
          <p className="text-xs text-neutral-400 mt-1">{movimentacoesFiltradas.length} movimentações</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {extrato.arquivo_url && (
            <a
              href={extrato.arquivo_url}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 bg-neutral-100 text-neutral-700 rounded-lg hover:bg-neutral-200 font-medium flex items-center gap-2"
            >
              <FileText size={18} />
              Baixar arquivo
            </a>
          )}
          {selectedIds.size > 0 && (
            <button
              onClick={handleDeleteMultiple}
              className="px-4 py-2 bg-rose-500 text-white rounded-lg hover:bg-rose-600 font-medium flex items-center gap-2"
            >
              <Trash2 size={18} />
              Remover {selectedIds.size}
            </button>
          )}
        </div>
      </div>

      {/* Cards de Resumo */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-emerald-50 rounded-lg border border-neutral-200 p-4">
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp size={18} className="text-emerald-600" />
            <p className="text-sm text-emerald-600 font-medium">Total Entradas</p>
          </div>
          <p className="text-xl font-bold text-emerald-700">
            R$ {formatCurrency(totalEntradas)}
          </p>
        </div>
        <div className="bg-rose-50 rounded-lg border border-neutral-200 p-4">
          <div className="flex items-center gap-2 mb-1">
            <TrendingDown size={18} className="text-rose-600" />
            <p className="text-sm text-rose-600 font-medium">Total Saídas</p>
          </div>
          <p className="text-xl font-bold text-rose-700">
            R$ {formatCurrency(totalSaidas)}
          </p>
        </div>
        <div className={`rounded-lg border p-4 ${totalEntradas - totalSaidas >= 0 ? 'bg-blue-50 border-neutral-200' : 'bg-neutral-100 border-neutral-200'}`}>
          <p className={`text-sm font-medium ${totalEntradas - totalSaidas >= 0 ? 'text-blue-600' : 'text-amber-600'}`}>Saldo</p>
          <p className={`text-xl font-bold ${totalEntradas - totalSaidas >= 0 ? 'text-blue-700' : 'text-amber-700'}`}>
            R$ {formatCurrency(totalEntradas - totalSaidas)}
          </p>
        </div>
      </div>

      {/* Filtros */}
      <div className="bg-white rounded-lg border border-neutral-200 p-4">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={18} />
            <input
              type="text"
              placeholder="Buscar por descrição..."
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-neutral-200 rounded-lg focus:border-neutral-400 focus:ring-2 focus:ring-neutral-100"
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
            className="px-4 py-2 border border-neutral-200 rounded-lg focus:border-neutral-400 focus:ring-2 focus:ring-neutral-100"
          >
            <option value="">Todos os tipos</option>
            <option value="entrada">Entradas</option>
            <option value="saida">Saídas</option>
          </select>
        </div>
      </div>

      {/* Tabela de Movimentações */}
      <div className="bg-white rounded-lg border border-neutral-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50">
              <tr>
                <th className="p-3 text-center w-12">
                  <button onClick={selectAll} className="text-neutral-400 hover:text-neutral-600">
                    {selectedIds.size === movimentacoesFiltradas.length && movimentacoesFiltradas.length > 0 ? <CheckSquare size={18} /> : <Square size={18} />}
                  </button>
                </th>
                <th className="p-3 text-left font-medium text-neutral-600">Data</th>
                <th className="p-3 text-left font-medium text-neutral-600">Descrição</th>
                <th className="p-3 text-right font-medium text-neutral-600">Valor</th>
                <th className="p-3 text-center font-medium text-neutral-600">Tipo</th>
                <th className="p-3 text-center font-medium text-neutral-600">Categoria</th>
                <th className="p-3 text-center font-medium text-neutral-600">Ações</th>
              </tr>
            </thead>
            <tbody>
              {movimentacoesFiltradas.map(m => (
                <tr key={m.id} className={`border-t border-neutral-100 hover:bg-neutral-50 ${selectedIds.has(m.id) ? 'bg-neutral-100' : ''}`}>
                  <td className="p-3 text-center">
                    <button onClick={() => toggleSelection(m.id)} className="text-neutral-400 hover:text-neutral-600">
                      {selectedIds.has(m.id) ? <CheckSquare size={18} className="text-neutral-900" /> : <Square size={18} />}
                    </button>
                  </td>
                  <td className="p-3 text-neutral-600">{formatDate(m.data)}</td>
                  <td className="p-3 max-w-xs">
                    <span className="truncate block text-neutral-900" title={m.descricao}>{m.descricao}</span>
                  </td>
                  <td className={`p-3 text-right font-mono font-medium ${m.tipo === 'entrada' ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {m.tipo === 'entrada' ? '+' : '-'} R$ {formatCurrency(m.valor)}
                  </td>
                  <td className="p-3 text-center">
                    <span className={`px-2 py-1 rounded text-xs font-medium ${m.tipo === 'entrada' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
                      {m.tipo === 'entrada' ? 'Entrada' : 'Saída'}
                    </span>
                  </td>
                  <td className="p-3 text-center">
                    <select
                      value={m.categoria || 'Outros'}
                      onChange={(e) => handleUpdateCategoria(m.id, e.target.value)}
                      className={`px-2 py-1 rounded text-xs font-medium cursor-pointer appearance-none bg-transparent ${CATEGORY_COLORS[m.categoria] || 'bg-neutral-100 text-neutral-600'}`}
                    >
                      {Object.keys(CATEGORY_COLORS).map(cat => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                      {!CATEGORY_COLORS[m.categoria] && m.categoria && (
                        <option value={m.categoria}>{m.categoria}</option>
                      )}
                    </select>
                  </td>
                  <td className="p-3 text-center">
                    <button
                      onClick={() => handleDeleteSingle(m)}
                      className="p-1.5 text-neutral-400 hover:text-rose-500 hover:bg-rose-50 rounded transition-colors"
                      title="Remover movimentação"
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
              {movimentacoesFiltradas.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-neutral-500">
                    Nenhuma movimentação encontrada
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal de Confirmação */}
      <ConfirmModal
        isOpen={deleteModal.open}
        onClose={() => setDeleteModal({ open: false, movimentacao: null, multiple: false })}
        onConfirm={handleConfirmDelete}
        title={deleteModal.multiple ? `Remover ${selectedIds.size} movimentações` : 'Remover movimentação'}
        message={deleteMessage}
        confirmText="Remover"
        variant="danger"
        loading={loadingAction}
      />
    </div>
  )
}

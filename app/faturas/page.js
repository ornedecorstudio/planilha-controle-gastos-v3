'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Trash2, CheckSquare, Square, FileText } from 'lucide-react'
import ConfirmModal from '@/components/ConfirmModal'

export default function FaturasPage() {
  const [faturas, setFaturas] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [deleteModal, setDeleteModal] = useState({ open: false, fatura: null, multiple: false })
  const [loadingAction, setLoadingAction] = useState(false)

  useEffect(() => {
    const carregarFaturas = async () => {
      try {
        const response = await fetch('/api/faturas?limit=50')
        const result = await response.json()
        if (result.error) throw new Error(result.error)
        setFaturas(result.faturas || [])
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }
    carregarFaturas()
  }, [])

  const atualizarStatus = async (id, novoStatus) => {
    try {
      const response = await fetch('/api/faturas', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status: novoStatus })
      })
      const result = await response.json()
      if (result.error) throw new Error(result.error)

      setFaturas(prev => prev.map(f => f.id === id ? { ...f, status: novoStatus } : f))
    } catch (err) {
      alert('Erro ao atualizar: ' + err.message)
    }
  }

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
    if (selectedIds.size === faturas.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(faturas.map(f => f.id)))
    }
  }

  const handleDeleteSingle = (fatura) => {
    setDeleteModal({ open: true, fatura, multiple: false })
  }

  const handleDeleteMultiple = () => {
    if (selectedIds.size === 0) return
    setDeleteModal({ open: true, fatura: null, multiple: true })
  }

  const handleConfirmDelete = async () => {
    setLoadingAction(true)
    try {
      if (deleteModal.multiple) {
        const res = await fetch(`/api/faturas?ids=${Array.from(selectedIds).join(',')}`, { method: 'DELETE' })
        const result = await res.json()
        if (result.error) throw new Error(result.error)
        setFaturas(prev => prev.filter(f => !selectedIds.has(f.id)))
        setSelectedIds(new Set())
      } else {
        const res = await fetch(`/api/faturas?id=${deleteModal.fatura.id}`, { method: 'DELETE' })
        const result = await res.json()
        if (result.error) throw new Error(result.error)
        setFaturas(prev => prev.filter(f => f.id !== deleteModal.fatura.id))
        selectedIds.delete(deleteModal.fatura.id)
        setSelectedIds(new Set(selectedIds))
      }
      setDeleteModal({ open: false, fatura: null, multiple: false })
    } catch (err) {
      alert('Erro ao remover: ' + err.message)
    } finally {
      setLoadingAction(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-neutral-300 border-t-neutral-900"></div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-white border border-neutral-200 rounded-lg p-4 text-center">
        <h2 className="text-section-title text-red-700">Erro ao carregar faturas</h2>
        <p className="text-body text-red-600 mt-1">{error}</p>
      </div>
    )
  }

  const totalPJ = faturas.reduce((a, f) => a + parseFloat(f.valor_pj || 0), 0)
  const totalPF = faturas.reduce((a, f) => a + parseFloat(f.valor_pf || 0), 0)

  const deleteMessage = deleteModal.multiple
    ? `Tem certeza que deseja remover ${selectedIds.size} faturas selecionadas? Todas as transações dessas faturas também serão removidas. Esta ação não pode ser desfeita.`
    : `Tem certeza que deseja remover a fatura "${deleteModal.fatura?.cartoes?.nome || 'N/A'} - ${deleteModal.fatura?.mes_referencia ? new Date(deleteModal.fatura.mes_referencia).toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' }) : ''}"? Todas as transações dessa fatura também serão removidas. Esta ação não pode ser desfeita.`

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-page-title text-neutral-900">Faturas</h1>
          <p className="text-body text-neutral-500">{faturas.length} faturas cadastradas</p>
        </div>
        <div className="flex gap-2">
          {selectedIds.size > 0 && (
            <button
              onClick={handleDeleteMultiple}
              className="px-3 py-1.5 bg-red-600 text-white rounded-lg hover:bg-red-700 text-[13px] font-medium flex items-center gap-1.5"
            >
              <Trash2 size={14} strokeWidth={1.5} />
              Remover {selectedIds.size}
            </button>
          )}
        </div>
      </div>

      {/* Totais */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-lg border border-neutral-200 p-4">
          <p className="text-label text-neutral-500">Total geral</p>
          <p className="text-kpi text-neutral-900 mt-1">
            R$ {(totalPJ + totalPF).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
          </p>
        </div>
        <div className="bg-white rounded-lg border border-neutral-200 p-4">
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <p className="text-label text-neutral-500">Total PJ (reembolsável)</p>
          </div>
          <p className="text-kpi text-neutral-900 mt-1">
            R$ {totalPJ.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
          </p>
        </div>
        <div className="bg-white rounded-lg border border-neutral-200 p-4">
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
            <p className="text-label text-neutral-500">Total PF (pessoal)</p>
          </div>
          <p className="text-kpi text-neutral-900 mt-1">
            R$ {totalPF.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
          </p>
        </div>
      </div>

      {/* Tabela */}
      {faturas.length > 0 ? (
        <div className="bg-white rounded-lg border border-neutral-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-neutral-50">
                <tr>
                  <th className="py-2 px-3 text-center w-10">
                    <button onClick={selectAll} className="text-neutral-400 hover:text-neutral-600">
                      {selectedIds.size === faturas.length ? <CheckSquare size={16} strokeWidth={1.5} /> : <Square size={16} strokeWidth={1.5} />}
                    </button>
                  </th>
                  <th className="py-2 px-3 text-left text-[11px] uppercase tracking-wider font-medium text-neutral-400">Cartão</th>
                  <th className="py-2 px-3 text-left text-[11px] uppercase tracking-wider font-medium text-neutral-400">Mês</th>
                  <th className="py-2 px-3 text-left text-[11px] uppercase tracking-wider font-medium text-neutral-400">Vencimento</th>
                  <th className="py-2 px-3 text-right text-[11px] uppercase tracking-wider font-medium text-neutral-400">Total</th>
                  <th className="py-2 px-3 text-right text-[11px] uppercase tracking-wider font-medium text-neutral-400">PJ</th>
                  <th className="py-2 px-3 text-right text-[11px] uppercase tracking-wider font-medium text-neutral-400">PF</th>
                  <th className="py-2 px-3 text-center text-[11px] uppercase tracking-wider font-medium text-neutral-400">Status</th>
                  <th className="py-2 px-3 text-center text-[11px] uppercase tracking-wider font-medium text-neutral-400">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {faturas.map(f => (
                  <tr key={f.id} className={`hover:bg-neutral-50 ${selectedIds.has(f.id) ? 'bg-neutral-100' : ''}`}>
                    <td className="py-2 px-3 text-center">
                      <button onClick={() => toggleSelection(f.id)} className="text-neutral-400 hover:text-neutral-600">
                        {selectedIds.has(f.id) ? <CheckSquare size={16} strokeWidth={1.5} className="text-neutral-900" /> : <Square size={16} strokeWidth={1.5} />}
                      </button>
                    </td>
                    <td className="py-2 px-3 text-[13px] font-medium text-neutral-900">
                      {f.cartoes?.nome || 'N/A'}
                      <span className="text-[11px] text-neutral-400 ml-1">({f.cartoes?.tipo})</span>
                    </td>
                    <td className="py-2 px-3 text-[13px] text-neutral-500">
                      {new Date(f.mes_referencia).toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' })}
                    </td>
                    <td className="py-2 px-3 text-[13px] text-neutral-500">
                      {f.data_vencimento ? new Date(f.data_vencimento).toLocaleDateString('pt-BR') : '-'}
                    </td>
                    <td className="py-2 px-3 text-right text-[13px] font-mono font-medium text-neutral-900">
                      R$ {parseFloat(f.valor_total || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="py-2 px-3 text-right text-[13px] font-mono text-neutral-600">
                      R$ {parseFloat(f.valor_pj || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="py-2 px-3 text-right text-[13px] font-mono text-neutral-600">
                      R$ {parseFloat(f.valor_pf || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="py-2 px-3 text-center">
                      <select
                        value={f.status}
                        onChange={(e) => atualizarStatus(f.id, e.target.value)}
                        className={`px-1.5 py-0.5 rounded text-[11px] font-medium cursor-pointer
                          ${f.status === 'pendente' ? 'bg-amber-100 text-amber-800' : ''}
                          ${f.status === 'pago' ? 'bg-blue-100 text-blue-800' : ''}
                          ${f.status === 'reembolsado' ? 'bg-green-100 text-green-800' : ''}
                        `}
                      >
                        <option value="pendente">Pendente</option>
                        <option value="pago">Pago</option>
                        <option value="reembolsado">Reembolsado</option>
                      </select>
                    </td>
                    <td className="py-2 px-3 text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        {f.pdf_url && (
                          <button
                            onClick={() => window.open(f.pdf_url, '_blank')}
                            className="p-1 text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 rounded transition-colors"
                            title="Ver PDF"
                          >
                            <FileText size={14} strokeWidth={1.5} />
                          </button>
                        )}
                        <Link href={`/faturas/${f.id}`} className="text-neutral-500 hover:text-neutral-900 text-[11px]">
                          Detalhes
                        </Link>
                        <button
                          onClick={() => handleDeleteSingle(f)}
                          className="p-1 text-neutral-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                          title="Remover fatura"
                        >
                          <Trash2 size={14} strokeWidth={1.5} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-neutral-200 p-8 text-center">
          <FileText className="mx-auto mb-3 text-neutral-300" size={24} strokeWidth={1.5} />
          <h3 className="text-section-title text-neutral-700">Nenhuma fatura</h3>
          <p className="text-body text-neutral-500 mt-0.5">Importe sua primeira fatura para começar</p>
          <Link href="/upload" className="inline-block mt-3 px-3 py-1.5 bg-neutral-900 text-white text-[13px] font-medium rounded-lg hover:bg-neutral-800">
            Importar fatura
          </Link>
        </div>
      )}

      <ConfirmModal
        isOpen={deleteModal.open}
        onClose={() => setDeleteModal({ open: false, fatura: null, multiple: false })}
        onConfirm={handleConfirmDelete}
        title={deleteModal.multiple ? `Remover ${selectedIds.size} faturas` : 'Remover fatura'}
        message={deleteMessage}
        confirmText="Remover"
        variant="danger"
        loading={loadingAction}
      />
    </div>
  )
}

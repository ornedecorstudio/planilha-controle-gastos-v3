'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Trash2, Copy } from 'lucide-react'
import ConfirmModal from '@/components/ConfirmModal'
import DuplicatesModal from '@/components/DuplicatesModal'

export default function ReconciliacaoPage() {
  const [loading, setLoading] = useState(true)
  const [faturas, setFaturas] = useState([])
  const [movimentacoes, setMovimentacoes] = useState([])
  const [resumo, setResumo] = useState({})
  const [sugestoes, setSugestoes] = useState([])
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [deleteModal, setDeleteModal] = useState({ open: false, movimentacao: null })
  const [duplicatesModal, setDuplicatesModal] = useState({ open: false, duplicatas: [] })
  const [loadingAction, setLoadingAction] = useState(false)

  useEffect(() => {
    carregarDados()
  }, [])

  const carregarDados = async () => {
    try {
      setLoading(true)
      const response = await fetch('/api/reembolsos?tipo=todos')
      const data = await response.json()
      if (data.error) throw new Error(data.error)
      setFaturas(data.faturas || [])
      setMovimentacoes(data.movimentacoes_reembolso || [])
      setResumo(data.resumo || {})

      const sugResponse = await fetch('/api/reembolsos', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acao: 'sugerir' })
      })
      const sugData = await sugResponse.json()
      setSugestoes(sugData.sugestoes || [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const marcarReembolsado = async (faturaId, movimentacaoId = null) => {
    try {
      const response = await fetch('/api/reembolsos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fatura_id: faturaId, movimentacao_id: movimentacaoId })
      })
      const data = await response.json()
      if (data.error) throw new Error(data.error)
      setSuccess('Fatura marcada como reembolsada!')
      setTimeout(() => setSuccess(''), 3000)
      carregarDados()
    } catch (err) {
      setError(err.message)
      setTimeout(() => setError(''), 3000)
    }
  }

  const handleDeleteMovimentacao = async () => {
    if (!deleteModal.movimentacao) return
    setLoadingAction(true)
    try {
      const res = await fetch(`/api/reembolsos?id=${deleteModal.movimentacao.id}`, { method: 'DELETE' })
      const result = await res.json()
      if (result.error) throw new Error(result.error)
      setMovimentacoes(prev => prev.filter(m => m.id !== deleteModal.movimentacao.id))
      setDeleteModal({ open: false, movimentacao: null })
      setSuccess('Movimentação removida')
      setTimeout(() => setSuccess(''), 3000)
    } catch (err) {
      setError('Erro ao remover: ' + err.message)
      setTimeout(() => setError(''), 3000)
    } finally {
      setLoadingAction(false)
    }
  }

  const handleCheckDuplicates = async () => {
    setLoadingAction(true)
    try {
      const res = await fetch('/api/reembolsos?duplicates=true', { method: 'DELETE' })
      const result = await res.json()
      if (result.error) throw new Error(result.error)
      if (result.duplicadas && result.duplicadas.length > 0) {
        setDuplicatesModal({ open: true, duplicatas: result.duplicadas })
      } else {
        setSuccess('Nenhuma movimentação duplicada encontrada.')
        setTimeout(() => setSuccess(''), 3000)
      }
    } catch (err) {
      setError('Erro ao verificar duplicadas: ' + err.message)
      setTimeout(() => setError(''), 3000)
    } finally {
      setLoadingAction(false)
    }
  }

  const handleDeleteDuplicates = async (ids) => {
    if (ids.length === 0) return
    setLoadingAction(true)
    try {
      const res = await fetch(`/api/reembolsos?ids=${ids.join(',')}`, { method: 'DELETE' })
      const result = await res.json()
      if (result.error) throw new Error(result.error)
      setMovimentacoes(prev => prev.filter(m => !ids.includes(m.id)))
      setDuplicatesModal({ open: false, duplicatas: [] })
      setSuccess(`${ids.length} movimentações duplicadas removidas`)
      setTimeout(() => setSuccess(''), 3000)
      carregarDados()
    } catch (err) {
      setError('Erro ao remover duplicadas: ' + err.message)
      setTimeout(() => setError(''), 3000)
    } finally {
      setLoadingAction(false)
    }
  }

  const formatCurrency = (value) => {
    return (parseFloat(value) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }

  const formatDate = (date) => {
    if (!date) return '-'
    return new Date(date + 'T12:00:00').toLocaleDateString('pt-BR')
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-neutral-300 border-t-neutral-900"></div>
      </div>
    )
  }

  const faturasPendentes = faturas.filter(f => f.status !== 'reembolsado')
  const faturasReembolsadas = faturas.filter(f => f.status === 'reembolsado')

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-page-title text-neutral-900">Reconciliação de Reembolsos</h1>
          <p className="text-body text-neutral-500">Vincule faturas PF com reembolsos do extrato PJ</p>
        </div>
        <Link href="/extratos" className="px-3 py-1.5 bg-neutral-900 text-white rounded-lg hover:bg-neutral-800 text-[13px] font-medium">
          Novo extrato
        </Link>
      </div>

      {error && <div className="p-3 bg-red-50 border border-neutral-200 rounded-lg text-[13px] text-red-700">{error}</div>}
      {success && <div className="p-3 bg-green-50 border border-neutral-200 rounded-lg text-[13px] text-green-700">{success}</div>}

      {/* Cards de Resumo */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border border-neutral-200 p-4">
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
            <p className="text-label text-neutral-500">Pendente de Reembolso</p>
          </div>
          <p className="text-kpi text-neutral-900 mt-1">R$ {formatCurrency(resumo.total_pendente)}</p>
          <p className="text-label text-neutral-400 mt-0.5">{resumo.faturas_pendentes} faturas</p>
        </div>
        <div className="bg-white rounded-lg border border-neutral-200 p-4">
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <p className="text-label text-neutral-500">Total Reembolsado</p>
          </div>
          <p className="text-kpi text-neutral-900 mt-1">R$ {formatCurrency(resumo.total_reembolsado)}</p>
          <p className="text-label text-neutral-400 mt-0.5">{resumo.faturas_reembolsadas} faturas</p>
        </div>
        <div className="bg-white rounded-lg border border-neutral-200 p-4">
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
            <p className="text-label text-neutral-500">PIX ao Sócio (Extrato)</p>
          </div>
          <p className="text-kpi text-neutral-900 mt-1">R$ {formatCurrency(resumo.total_movimentacoes)}</p>
          <p className="text-label text-neutral-400 mt-0.5">{movimentacoes.length} transferências</p>
        </div>
        <div className="bg-white rounded-lg border border-neutral-200 p-4">
          <p className="text-label text-neutral-500">Diferença</p>
          <p className="text-kpi text-neutral-900 mt-1">
            R$ {formatCurrency(Math.abs((resumo.total_movimentacoes || 0) - (resumo.total_reembolsado || 0)))}
          </p>
          <p className="text-label text-neutral-400 mt-0.5">Extrato vs Faturas</p>
        </div>
      </div>

      {/* Sugestões de Vinculação */}
      {sugestoes.length > 0 && (
        <div className="bg-white rounded-lg border border-neutral-200 p-4">
          <h2 className="text-section-title text-neutral-900 mb-3">
            Sugestões de Vinculação ({sugestoes.length})
          </h2>
          <div className="space-y-2">
            {sugestoes.filter(s => s.confianca === 'alta').map((sug, i) => (
              <div key={i} className="bg-neutral-50 rounded-lg p-3 flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 bg-emerald-100 text-emerald-700 text-[11px] rounded font-medium">
                      Match Exato
                    </span>
                    <span className="text-[13px] font-medium text-neutral-900">
                      {sug.fatura.cartoes?.nome || 'Cartão'}
                    </span>
                    <span className="text-neutral-300">→</span>
                    <span className="text-[13px] text-neutral-500">
                      PIX {formatDate(sug.movimentacao?.data)}
                    </span>
                  </div>
                  <p className="text-label text-neutral-400 mt-1">
                    Fatura: R$ {formatCurrency(sug.fatura.valor_pj)} PJ •
                    Reembolso: R$ {formatCurrency(sug.movimentacao?.valor)}
                  </p>
                </div>
                <button
                  onClick={() => marcarReembolsado(sug.fatura.id, sug.movimentacao?.id)}
                  className="px-3 py-1.5 bg-neutral-900 text-white rounded-lg hover:bg-neutral-800 text-[13px] font-medium"
                >
                  Vincular
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Faturas Pendentes */}
      <div className="bg-white rounded-lg border border-neutral-200">
        <div className="px-4 py-3 border-b border-neutral-100 bg-neutral-50">
          <h2 className="text-section-title text-neutral-900">
            Faturas Pendentes de Reembolso ({faturasPendentes.length})
          </h2>
        </div>
        {faturasPendentes.length === 0 ? (
          <div className="p-6 text-center text-[13px] text-neutral-500">
            Todas as faturas foram reembolsadas!
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-neutral-50">
                <tr>
                  <th className="py-2 px-3 text-left text-[11px] uppercase tracking-wider font-medium text-neutral-400">Cartão</th>
                  <th className="py-2 px-3 text-left text-[11px] uppercase tracking-wider font-medium text-neutral-400">Mês</th>
                  <th className="py-2 px-3 text-right text-[11px] uppercase tracking-wider font-medium text-neutral-400">Valor PJ</th>
                  <th className="py-2 px-3 text-right text-[11px] uppercase tracking-wider font-medium text-neutral-400">Valor PF</th>
                  <th className="py-2 px-3 text-center text-[11px] uppercase tracking-wider font-medium text-neutral-400">Status</th>
                  <th className="py-2 px-3 text-center text-[11px] uppercase tracking-wider font-medium text-neutral-400">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {faturasPendentes.map(f => (
                  <tr key={f.id} className="hover:bg-neutral-50">
                    <td className="py-2 px-3">
                      <span className="text-[13px] font-medium text-neutral-900">{f.cartoes?.nome || 'N/A'}</span>
                      <span className="text-[11px] text-neutral-400 ml-1">({f.cartoes?.banco})</span>
                    </td>
                    <td className="py-2 px-3 text-[13px] text-neutral-500">
                      {new Date(f.mes_referencia).toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' })}
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-[13px] text-neutral-600">
                      R$ {formatCurrency(f.valor_pj)}
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-[13px] text-neutral-600">
                      R$ {formatCurrency(f.valor_pf)}
                    </td>
                    <td className="py-2 px-3 text-center">
                      <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${
                        f.status === 'pago' ? 'bg-blue-100 text-blue-800' : 'bg-amber-100 text-amber-700'
                      }`}>
                        {f.status === 'pago' ? 'Pago' : 'Pendente'}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-center">
                      <button
                        onClick={() => marcarReembolsado(f.id)}
                        className="px-2 py-1 bg-neutral-100 text-neutral-700 rounded hover:bg-neutral-200 text-[11px] font-medium"
                      >
                        Marcar Reembolsado
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Movimentações de Reembolso */}
      <div className="bg-white rounded-lg border border-neutral-200">
        <div className="px-4 py-3 border-b border-neutral-100 bg-neutral-50 flex justify-between items-center">
          <div>
            <h2 className="text-section-title text-neutral-900">
              PIX Enviados ao Sócio ({movimentacoes.length})
            </h2>
            <p className="text-label text-neutral-400">Transferências identificadas como reembolso no extrato PJ</p>
          </div>
          {movimentacoes.length > 0 && (
            <button
              onClick={handleCheckDuplicates}
              disabled={loadingAction}
              className="px-3 py-1.5 text-[13px] text-neutral-600 bg-white border border-neutral-200 rounded-lg hover:bg-neutral-50 flex items-center gap-1.5 disabled:opacity-50"
            >
              <Copy size={14} strokeWidth={1.5} />
              Verificar duplicadas
            </button>
          )}
        </div>
        {movimentacoes.length === 0 ? (
          <div className="p-6 text-center text-[13px] text-neutral-500">
            <p>Nenhum reembolso identificado nos extratos.</p>
            <Link href="/extratos" className="text-neutral-600 hover:underline">
              Importar extrato →
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-neutral-50">
                <tr>
                  <th className="py-2 px-3 text-left text-[11px] uppercase tracking-wider font-medium text-neutral-400">Data</th>
                  <th className="py-2 px-3 text-left text-[11px] uppercase tracking-wider font-medium text-neutral-400">Descrição</th>
                  <th className="py-2 px-3 text-right text-[11px] uppercase tracking-wider font-medium text-neutral-400">Valor</th>
                  <th className="py-2 px-3 text-center text-[11px] uppercase tracking-wider font-medium text-neutral-400">Vinculado</th>
                  <th className="py-2 px-3 text-center w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {movimentacoes.slice(0, 20).map(m => (
                  <tr key={m.id} className={`hover:bg-neutral-50 ${m.fatura_vinculada_id ? 'bg-emerald-50/30' : ''}`}>
                    <td className="py-2 px-3 font-mono text-[11px] text-neutral-500">{formatDate(m.data)}</td>
                    <td className="py-2 px-3 text-[13px] max-w-xs truncate text-neutral-900" title={m.descricao}>{m.descricao}</td>
                    <td className="py-2 px-3 text-right font-mono text-[13px] font-medium text-neutral-900">
                      R$ {formatCurrency(m.valor)}
                    </td>
                    <td className="py-2 px-3 text-center text-[13px]">
                      {m.fatura_vinculada_id ? (
                        <span className="text-emerald-600">Sim</span>
                      ) : (
                        <span className="text-neutral-400">-</span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-center">
                      <button
                        onClick={() => setDeleteModal({ open: true, movimentacao: m })}
                        className="p-1 text-neutral-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                        title="Remover movimentação"
                      >
                        <Trash2 size={14} strokeWidth={1.5} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Faturas Reembolsadas */}
      {faturasReembolsadas.length > 0 && (
        <div className="bg-white rounded-lg border border-neutral-200">
          <div className="px-4 py-3 border-b border-neutral-100 bg-neutral-50">
            <h2 className="text-section-title text-neutral-900">
              Faturas Reembolsadas ({faturasReembolsadas.length})
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-neutral-50">
                <tr>
                  <th className="py-2 px-3 text-left text-[11px] uppercase tracking-wider font-medium text-neutral-400">Cartão</th>
                  <th className="py-2 px-3 text-left text-[11px] uppercase tracking-wider font-medium text-neutral-400">Mês</th>
                  <th className="py-2 px-3 text-right text-[11px] uppercase tracking-wider font-medium text-neutral-400">Valor PJ</th>
                  <th className="py-2 px-3 text-center text-[11px] uppercase tracking-wider font-medium text-neutral-400">Data Reembolso</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {faturasReembolsadas.slice(0, 10).map(f => (
                  <tr key={f.id} className="hover:bg-neutral-50">
                    <td className="py-2 px-3 text-[13px] font-medium text-neutral-900">{f.cartoes?.nome || 'N/A'}</td>
                    <td className="py-2 px-3 text-[13px] text-neutral-500">
                      {new Date(f.mes_referencia).toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' })}
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-[13px] text-neutral-600">
                      R$ {formatCurrency(f.valor_pj)}
                    </td>
                    <td className="py-2 px-3 text-center text-[13px] text-neutral-500">
                      {f.data_pagamento ? formatDate(f.data_pagamento) : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={deleteModal.open}
        onClose={() => setDeleteModal({ open: false, movimentacao: null })}
        onConfirm={handleDeleteMovimentacao}
        title="Remover movimentação"
        message={`Tem certeza que deseja remover "${deleteModal.movimentacao?.descricao?.substring(0, 50)}..."? Esta ação não pode ser desfeita.`}
        confirmText="Remover"
        variant="danger"
        loading={loadingAction}
      />

      <DuplicatesModal
        isOpen={duplicatesModal.open}
        onClose={() => setDuplicatesModal({ open: false, duplicatas: [] })}
        duplicatas={duplicatesModal.duplicatas}
        onConfirm={handleDeleteDuplicates}
        loading={loadingAction}
      />
    </div>
  )
}

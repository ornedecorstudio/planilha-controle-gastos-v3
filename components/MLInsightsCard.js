'use client'

import { useState, useEffect } from 'react'
import { Brain, TrendingUp, AlertCircle, Zap } from 'lucide-react'

export default function MLInsightsCard() {
  const [mlInfo, setMlInfo] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchMLInfo = async () => {
      try {
        const res = await fetch('/api/ml/categorize')
        if (res.ok) {
          const data = await res.json()
          setMlInfo(data)
        }
      } catch (err) {
        // ML não disponível - silencioso
      } finally {
        setLoading(false)
      }
    }
    fetchMLInfo()
  }, [])

  if (loading || !mlInfo) return null
  if (!mlInfo.available) return null

  const report = mlInfo.report
  if (!report) return null

  const tipoAcc = report.models?.tipo?.accuracy
  const pjAcc = report.models?.pj?.accuracy
  const pfAcc = report.models?.pf?.accuracy
  const totalSamples = report.total_samples || 0
  const manualCorrections = report.manual_corrections || 0
  const trainDate = report.timestamp
    ? new Date(report.timestamp).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
    : null

  return (
    <div className="bg-white rounded-lg border border-neutral-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Brain size={16} strokeWidth={1.5} className="text-indigo-500" />
          <h2 className="text-section-title text-neutral-900">Modelo ML</h2>
        </div>
        {trainDate && (
          <span className="text-[11px] text-neutral-400">
            Treinado em {trainDate}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {/* PJ/PF Accuracy */}
        <div className="p-2.5 bg-neutral-50 rounded-lg">
          <div className="flex items-center gap-1.5 mb-1">
            <Zap size={12} strokeWidth={1.5} className="text-indigo-500" />
            <p className="text-[11px] text-neutral-500">PJ/PF</p>
          </div>
          <p className="text-[18px] font-semibold text-neutral-900">
            {tipoAcc ? `${(tipoAcc * 100).toFixed(0)}%` : '-'}
          </p>
          <p className="text-[11px] text-neutral-400">acurácia</p>
        </div>

        {/* Category Accuracy */}
        <div className="p-2.5 bg-neutral-50 rounded-lg">
          <div className="flex items-center gap-1.5 mb-1">
            <TrendingUp size={12} strokeWidth={1.5} className="text-emerald-500" />
            <p className="text-[11px] text-neutral-500">Categorias</p>
          </div>
          <p className="text-[18px] font-semibold text-neutral-900">
            {pjAcc && pfAcc
              ? `${(((pjAcc + pfAcc) / 2) * 100).toFixed(0)}%`
              : pjAcc
                ? `${(pjAcc * 100).toFixed(0)}%`
                : '-'}
          </p>
          <p className="text-[11px] text-neutral-400">acurácia média</p>
        </div>

        {/* Training Data */}
        <div className="p-2.5 bg-neutral-50 rounded-lg">
          <div className="flex items-center gap-1.5 mb-1">
            <Brain size={12} strokeWidth={1.5} className="text-blue-500" />
            <p className="text-[11px] text-neutral-500">Treino</p>
          </div>
          <p className="text-[18px] font-semibold text-neutral-900">
            {totalSamples.toLocaleString('pt-BR')}
          </p>
          <p className="text-[11px] text-neutral-400">transações</p>
        </div>

        {/* Manual Corrections */}
        <div className="p-2.5 bg-neutral-50 rounded-lg">
          <div className="flex items-center gap-1.5 mb-1">
            <AlertCircle size={12} strokeWidth={1.5} className="text-amber-500" />
            <p className="text-[11px] text-neutral-500">Manuais</p>
          </div>
          <p className="text-[18px] font-semibold text-neutral-900">
            {manualCorrections.toLocaleString('pt-BR')}
          </p>
          <p className="text-[11px] text-neutral-400">correções</p>
        </div>
      </div>
    </div>
  )
}

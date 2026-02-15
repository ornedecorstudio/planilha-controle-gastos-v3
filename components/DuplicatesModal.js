'use client'

import { useState } from 'react'
import { X, AlertTriangle, Check } from 'lucide-react'

export default function DuplicatesModal({
  isOpen,
  onClose,
  duplicatas = [],
  onConfirm,
  loading = false
}) {
  const [selectedIds, setSelectedIds] = useState(new Set(duplicatas.map(d => d.id)))
  const [confirmStep, setConfirmStep] = useState(false)

  if (!isOpen) return null

  const toggleSelection = (id) => {
    const newSet = new Set(selectedIds)
    if (newSet.has(id)) {
      newSet.delete(id)
    } else {
      newSet.add(id)
    }
    setSelectedIds(newSet)
  }

  const selectAll = () => setSelectedIds(new Set(duplicatas.map(d => d.id)))
  const deselectAll = () => setSelectedIds(new Set())

  const handleConfirm = () => {
    if (!confirmStep) {
      setConfirmStep(true)
      return
    }
    onConfirm(Array.from(selectedIds))
  }

  const handleClose = () => {
    setConfirmStep(false)
    setSelectedIds(new Set(duplicatas.map(d => d.id)))
    onClose()
  }

  const total = duplicatas.reduce((acc, d) => selectedIds.has(d.id) ? acc + parseFloat(d.valor) : acc, 0)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] flex flex-col">
        <div className="p-4 border-b flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="text-amber-500" size={20} />
            <h3 className="text-lg font-semibold text-neutral-800">
              {duplicatas.length} transações duplicadas encontradas
            </h3>
          </div>
          <button onClick={handleClose} className="text-neutral-400 hover:text-neutral-600">
            <X size={20} />
          </button>
        </div>

        <div className="p-4 overflow-y-auto flex-1">
          {confirmStep ? (
            <div className="text-center py-8">
              <AlertTriangle className="text-red-500 mx-auto mb-4" size={48} />
              <h4 className="text-lg font-semibold text-neutral-800 mb-2">Confirmar remoção</h4>
              <p className="text-neutral-600 mb-4">
                Você está prestes a remover <strong>{selectedIds.size}</strong> transações
                totalizando <strong>R$ {total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</strong>.
              </p>
              <p className="text-red-600 text-sm">Esta ação não pode ser desfeita.</p>
            </div>
          ) : (
            <>
              <div className="flex gap-2 mb-4">
                <button onClick={selectAll} className="text-xs text-neutral-600 hover:text-neutral-800 underline">
                  selecionar todas
                </button>
                <span className="text-neutral-300">|</span>
                <button onClick={deselectAll} className="text-xs text-neutral-600 hover:text-neutral-800 underline">
                  desmarcar todas
                </button>
              </div>
              <p className="text-xs text-neutral-500 mb-3">
                Transações com mesma data, descrição e valor que já existem na fatura.
                A versão original será mantida, apenas as cópias serão removidas.
              </p>
              <div className="space-y-2">
                {duplicatas.map(d => (
                  <label
                    key={d.id}
                    className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      selectedIds.has(d.id) ? 'bg-red-50 border-red-200' : 'bg-neutral-50 border-neutral-200'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.has(d.id)}
                      onChange={() => toggleSelection(d.id)}
                      className="w-4 h-4 text-red-600 rounded border-neutral-300 focus:ring-red-500"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-neutral-700 truncate">{d.descricao}</p>
                      <p className="text-xs text-neutral-500">
                        {d.data ? new Date(d.data + 'T12:00:00').toLocaleDateString('pt-BR') : '-'} - {d.categoria}
                      </p>
                      {d.motivo && (
                        <p className="text-xs text-amber-600 mt-1">{d.motivo}</p>
                      )}
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-medium text-neutral-700">
                        R$ {parseFloat(d.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                      </p>
                      <span className={`text-xs px-1.5 py-0.5 rounded ${
                        d.tipo === 'PJ' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                      }`}>
                        {d.tipo}
                      </span>
                    </div>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="p-4 border-t bg-neutral-50 flex items-center justify-between">
          <div className="text-sm text-neutral-600">
            {selectedIds.size} selecionadas - R$ {total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleClose}
              disabled={loading}
              className="px-4 py-2 text-neutral-600 bg-white border border-neutral-200 rounded-lg hover:bg-neutral-100 font-medium disabled:opacity-50"
            >
              Cancelar
            </button>
            {confirmStep && (
              <button
                onClick={() => setConfirmStep(false)}
                disabled={loading}
                className="px-4 py-2 text-neutral-600 bg-white border border-neutral-200 rounded-lg hover:bg-neutral-100 font-medium disabled:opacity-50"
              >
                Voltar
              </button>
            )}
            <button
              onClick={handleConfirm}
              disabled={loading || selectedIds.size === 0}
              className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 font-medium disabled:opacity-50 flex items-center gap-2"
            >
              {loading ? 'Removendo...' : confirmStep ? (
                <><Check size={16} /> Confirmar remoção</>
              ) : (
                `Remover ${selectedIds.size} duplicadas`
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

'use client'

import { CheckCircle2, AlertTriangle, HelpCircle } from 'lucide-react'

/**
 * Componente visual de reconciliação de fatura.
 *
 * Mostra se o total calculado das transações bate com o total do PDF,
 * com indicador visual claro (verde/âmbar/cinza) e equação detalhada.
 *
 * @param {Object} props
 * @param {Object} props.auditoria - Objeto de auditoria padrão
 * @param {number} props.auditoria.total_compras
 * @param {number} props.auditoria.iof
 * @param {number} props.auditoria.estornos
 * @param {number} props.auditoria.pagamento_antecipado
 * @param {number} props.auditoria.tarifa_cartao
 * @param {number|null} props.auditoria.total_fatura_pdf
 * @param {number} props.auditoria.total_fatura_calculado
 * @param {boolean|null} props.auditoria.reconciliado
 * @param {number|null} props.auditoria.diferenca_centavos
 */
export default function ReconciliationCard({ auditoria }) {
  if (!auditoria) return null

  const { reconciliado } = auditoria

  // Status visual
  const isReconciliado = reconciliado === true
  const isDivergente = reconciliado === false
  const isIndeterminado = reconciliado === null

  // Classes por status
  const containerClass = isReconciliado
    ? 'bg-emerald-50 border-emerald-200'
    : isDivergente
      ? 'bg-amber-50 border-amber-200'
      : 'bg-neutral-50 border-neutral-200'

  const iconColor = isReconciliado
    ? 'text-emerald-600'
    : isDivergente
      ? 'text-amber-600'
      : 'text-neutral-400'

  const StatusIcon = isReconciliado
    ? CheckCircle2
    : isDivergente
      ? AlertTriangle
      : HelpCircle

  const statusLabel = isReconciliado
    ? 'Reconciliado'
    : isDivergente
      ? `Divergência: ${auditoria.diferenca_centavos} centavos`
      : 'Não verificável'

  const badgeClass = isReconciliado
    ? 'bg-emerald-100 text-emerald-700'
    : isDivergente
      ? 'bg-amber-100 text-amber-700'
      : 'bg-neutral-100 text-neutral-500'

  const fmt = (v) =>
    (v ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })

  return (
    <div className={`rounded-lg border p-4 ${containerClass}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <StatusIcon className={`w-4 h-4 ${iconColor}`} />
          <h3 className="text-[13px] font-medium text-neutral-900">
            Reconciliação da fatura
          </h3>
        </div>
        <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${badgeClass}`}>
          {statusLabel}
        </span>
      </div>

      {/* Equação detalhada */}
      <div className="space-y-1.5 text-[13px] font-mono">
        <div className="flex justify-between text-neutral-700">
          <span>Total compras (gross)</span>
          <span>R$ {fmt(auditoria.total_compras)}</span>
        </div>

        {(auditoria.iof ?? 0) > 0 && (
          <div className="flex justify-between text-neutral-500">
            <span>+ IOF</span>
            <span>R$ {fmt(auditoria.iof)}</span>
          </div>
        )}

        {(auditoria.tarifa_cartao ?? 0) > 0 && (
          <div className="flex justify-between text-neutral-500">
            <span>+ Tarifas cartão</span>
            <span>R$ {fmt(auditoria.tarifa_cartao)}</span>
          </div>
        )}

        {(auditoria.saldo_anterior ?? 0) > 0 && (
          <div className="flex justify-between text-neutral-500">
            <span>+ Saldo anterior</span>
            <span>R$ {fmt(auditoria.saldo_anterior)}</span>
          </div>
        )}

        {(auditoria.juros ?? 0) > 0 && (
          <div className="flex justify-between text-neutral-500">
            <span>+ Juros anterior</span>
            <span>R$ {fmt(auditoria.juros)}</span>
          </div>
        )}

        {(auditoria.multas ?? 0) > 0 && (
          <div className="flex justify-between text-neutral-500">
            <span>+ Multas atraso</span>
            <span>R$ {fmt(auditoria.multas)}</span>
          </div>
        )}

        {(auditoria.pagamento_fatura ?? 0) > 0 && (
          <div className="flex justify-between text-emerald-600">
            <span>- Pgto fatura</span>
            <span>- R$ {fmt(auditoria.pagamento_fatura)}</span>
          </div>
        )}

        {(auditoria.estornos ?? 0) > 0 && (
          <div className="flex justify-between text-emerald-600">
            <span>- Estornos</span>
            <span>- R$ {fmt(auditoria.estornos)}</span>
          </div>
        )}

        <div className="border-t border-neutral-200 pt-1.5 flex justify-between font-medium text-neutral-900">
          <span>= Total calculado</span>
          <span>R$ {fmt(auditoria.total_fatura_calculado)}</span>
        </div>

        {auditoria.total_fatura_pdf !== null && auditoria.total_fatura_pdf !== undefined && (
          <div className="flex justify-between text-neutral-500">
            <span>Total no PDF</span>
            <span>R$ {fmt(auditoria.total_fatura_pdf)}</span>
          </div>
        )}

        {isDivergente && auditoria.diferenca_centavos !== null && (
          <div className="flex justify-between text-amber-700 font-medium">
            <span>Diferença</span>
            <span>
              {Math.abs(auditoria.diferenca_centavos)} centavos
              {Math.abs(auditoria.diferenca_centavos) >= 100 && (
                <span className="ml-1 text-[11px] font-normal">
                  (R$ {(Math.abs(auditoria.diferenca_centavos) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })})
                </span>
              )}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Badge compacto de status de reconciliação.
 * Para uso no header do Step 2 ao lado de "X transações encontradas".
 */
export function ReconciliationBadge({ auditoria }) {
  if (!auditoria) return null

  const { reconciliado } = auditoria

  if (reconciliado === true) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-emerald-50 text-emerald-700 text-[11px] rounded font-medium">
        <CheckCircle2 className="w-3 h-3" />
        Reconciliado
      </span>
    )
  }

  if (reconciliado === false) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-amber-50 text-amber-700 text-[11px] rounded font-medium" title={`Diferença: ${auditoria.diferenca_centavos} centavos`}>
        <AlertTriangle className="w-3 h-3" />
        Divergente
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-neutral-100 text-neutral-500 text-[11px] rounded font-medium">
      <HelpCircle className="w-3 h-3" />
      Não verificável
    </span>
  )
}

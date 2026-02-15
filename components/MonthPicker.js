'use client'

import { useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

const MESES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril',
  'Maio', 'Junho', 'Julho', 'Agosto',
  'Setembro', 'Outubro', 'Novembro', 'Dezembro'
]

const MESES_ABREV = [
  'Jan', 'Fev', 'Mar', 'Abr',
  'Mai', 'Jun', 'Jul', 'Ago',
  'Set', 'Out', 'Nov', 'Dez'
]

export default function MonthPicker({ value, onChange, label = 'Mês de referência', required = false, placeholder, allowClear }) {
  const [isOpen, setIsOpen] = useState(false)

  const [selectedYear, selectedMonth] = value
    ? value.split('-').map(Number)
    : [new Date().getFullYear(), new Date().getMonth() + 1]

  const [viewYear, setViewYear] = useState(selectedYear || new Date().getFullYear())

  const handleMonthSelect = (month) => {
    const mesStr = String(month).padStart(2, '0')
    onChange(`${viewYear}-${mesStr}`)
    setIsOpen(false)
  }

  const prevYear = () => setViewYear(v => v - 1)
  const nextYear = () => setViewYear(v => v + 1)

  const displayValue = value
    ? `${MESES[selectedMonth - 1]} ${selectedYear}`
    : (placeholder || 'Selecione o mês...')

  return (
    <div className="relative">
      {label && (
        <label className="block text-label font-medium mb-1.5 text-neutral-500">
          {label} {required && <span className="text-red-500">*</span>}
        </label>
      )}

      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`
          w-full p-2.5 border rounded-lg text-left flex items-center justify-between
          transition-colors bg-white text-[13px]
          ${isOpen ? 'border-neutral-400 ring-2 ring-neutral-200' : 'border-neutral-200'}
          ${!value ? 'text-neutral-400' : 'text-neutral-900'}
          hover:border-neutral-300
        `}
      >
        <span>{displayValue}</span>
        <svg
          className={`w-4 h-4 text-neutral-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
          />

          <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-neutral-200 rounded-lg shadow-card z-20 p-3">
            <div className="flex items-center justify-between mb-3">
              <button
                type="button"
                onClick={prevYear}
                className="p-1.5 hover:bg-neutral-100 rounded-lg transition-colors"
              >
                <ChevronLeft size={16} strokeWidth={1.5} className="text-neutral-500" />
              </button>

              <span className="text-[14px] font-semibold text-neutral-800">
                {viewYear}
              </span>

              <button
                type="button"
                onClick={nextYear}
                className="p-1.5 hover:bg-neutral-100 rounded-lg transition-colors"
              >
                <ChevronRight size={16} strokeWidth={1.5} className="text-neutral-500" />
              </button>
            </div>

            <div className="grid grid-cols-4 gap-1.5">
              {MESES_ABREV.map((mes, index) => {
                const mesNum = index + 1
                const isSelected = viewYear === selectedYear && mesNum === selectedMonth
                const isCurrentMonth = viewYear === new Date().getFullYear() && mesNum === new Date().getMonth() + 1

                return (
                  <button
                    key={mes}
                    type="button"
                    onClick={() => handleMonthSelect(mesNum)}
                    className={`
                      py-1.5 px-2 rounded-md text-[13px] font-medium transition-all
                      ${isSelected
                        ? 'bg-neutral-900 text-white'
                        : isCurrentMonth
                          ? 'bg-neutral-100 text-neutral-900 ring-1 ring-neutral-300'
                          : 'text-neutral-600 hover:bg-neutral-100'
                      }
                    `}
                  >
                    {mes}
                  </button>
                )
              })}
            </div>

            <div className="mt-3 pt-2 border-t border-neutral-200 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  const now = new Date()
                  setViewYear(now.getFullYear())
                  handleMonthSelect(now.getMonth() + 1)
                }}
                className="flex-1 py-1.5 text-[12px] text-neutral-500 hover:bg-neutral-100 rounded-md transition-colors"
              >
                Mês atual
              </button>
              <button
                type="button"
                onClick={() => {
                  const now = new Date()
                  const prevMonth = now.getMonth() === 0 ? 12 : now.getMonth()
                  const prevYr = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()
                  setViewYear(prevYr)
                  handleMonthSelect(prevMonth)
                }}
                className="flex-1 py-1.5 text-[12px] text-neutral-500 hover:bg-neutral-100 rounded-md transition-colors"
              >
                Mês anterior
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

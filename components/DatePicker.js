'use client'

import { useState, useRef, useEffect } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

const MESES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril',
  'Maio', 'Junho', 'Julho', 'Agosto',
  'Setembro', 'Outubro', 'Novembro', 'Dezembro'
]

const DIAS_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

function parseDateStr(str) {
  if (!str) return null
  const [y, m, d] = str.split('-').map(Number)
  if (!y || !m || !d) return null
  return { year: y, month: m, day: d }
}

function toDateStr(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function formatDisplay(str) {
  if (!str) return null
  const parsed = parseDateStr(str)
  if (!parsed) return null
  return `${String(parsed.day).padStart(2, '0')}/${String(parsed.month).padStart(2, '0')}/${parsed.year}`
}

function getDaysInMonth(year, month) {
  return new Date(year, month, 0).getDate()
}

function getFirstDayOfWeek(year, month) {
  return new Date(year, month - 1, 1).getDay()
}

export default function DatePicker({ value, onChange, placeholder = 'Selecionar data...', inline = false }) {
  const [isOpen, setIsOpen] = useState(false)
  const triggerRef = useRef(null)

  const parsed = parseDateStr(value)
  const today = new Date()
  const todayYear = today.getFullYear()
  const todayMonth = today.getMonth() + 1
  const todayDay = today.getDate()

  const [viewYear, setViewYear] = useState(parsed?.year || todayYear)
  const [viewMonth, setViewMonth] = useState(parsed?.month || todayMonth)

  useEffect(() => {
    if (isOpen && parsed) {
      setViewYear(parsed.year)
      setViewMonth(parsed.month)
    }
  }, [isOpen])

  const prevMonth = () => {
    if (viewMonth === 1) {
      setViewMonth(12)
      setViewYear(v => v - 1)
    } else {
      setViewMonth(v => v - 1)
    }
  }

  const nextMonth = () => {
    if (viewMonth === 12) {
      setViewMonth(1)
      setViewYear(v => v + 1)
    } else {
      setViewMonth(v => v + 1)
    }
  }

  const handleDaySelect = (day) => {
    onChange(toDateStr(viewYear, viewMonth, day))
    setIsOpen(false)
  }

  const handleToday = () => {
    onChange(toDateStr(todayYear, todayMonth, todayDay))
    setIsOpen(false)
  }

  const handleClear = () => {
    onChange(null)
    setIsOpen(false)
  }

  // Build calendar grid
  const daysInMonth = getDaysInMonth(viewYear, viewMonth)
  const firstDay = getFirstDayOfWeek(viewYear, viewMonth)
  const daysInPrevMonth = getDaysInMonth(
    viewMonth === 1 ? viewYear - 1 : viewYear,
    viewMonth === 1 ? 12 : viewMonth - 1
  )

  const cells = []

  // Leading days from previous month
  for (let i = firstDay - 1; i >= 0; i--) {
    cells.push({ day: daysInPrevMonth - i, current: false })
  }

  // Current month days
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, current: true })
  }

  // Trailing days from next month
  const remaining = 42 - cells.length
  for (let d = 1; d <= remaining; d++) {
    cells.push({ day: d, current: false })
  }

  const displayValue = formatDisplay(value)

  return (
    <div className="relative" ref={triggerRef}>
      {inline ? (
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="text-[13px] text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 px-1.5 py-0.5 rounded cursor-pointer transition-colors whitespace-nowrap"
        >
          {displayValue || placeholder}
        </button>
      ) : (
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
          <span>{displayValue || placeholder}</span>
          <svg
            className={`w-4 h-4 text-neutral-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      )}

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
          />

          <div className="absolute top-full left-0 mt-1 bg-white border border-neutral-200 rounded-lg shadow-card z-20 p-3 w-[280px]">
            {/* Month/Year navigation */}
            <div className="flex items-center justify-between mb-2">
              <button
                type="button"
                onClick={prevMonth}
                className="p-1.5 hover:bg-neutral-100 rounded-lg transition-colors"
              >
                <ChevronLeft size={16} strokeWidth={1.5} className="text-neutral-500" />
              </button>

              <span className="text-[14px] font-semibold text-neutral-800">
                {MESES[viewMonth - 1]} {viewYear}
              </span>

              <button
                type="button"
                onClick={nextMonth}
                className="p-1.5 hover:bg-neutral-100 rounded-lg transition-colors"
              >
                <ChevronRight size={16} strokeWidth={1.5} className="text-neutral-500" />
              </button>
            </div>

            {/* Day of week headers */}
            <div className="grid grid-cols-7 gap-0 mb-1">
              {DIAS_SEMANA.map(dia => (
                <div key={dia} className="text-center text-[11px] uppercase tracking-wider font-medium text-neutral-400 py-1">
                  {dia}
                </div>
              ))}
            </div>

            {/* Day grid */}
            <div className="grid grid-cols-7 gap-0">
              {cells.map((cell, idx) => {
                const isToday = cell.current && viewYear === todayYear && viewMonth === todayMonth && cell.day === todayDay
                const isSelected = cell.current && parsed && viewYear === parsed.year && viewMonth === parsed.month && cell.day === parsed.day

                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => cell.current && handleDaySelect(cell.day)}
                    disabled={!cell.current}
                    className={`
                      w-full aspect-square flex items-center justify-center rounded-md text-[13px] transition-all
                      ${!cell.current
                        ? 'text-neutral-300 cursor-default'
                        : isSelected
                          ? 'bg-neutral-900 text-white font-medium'
                          : isToday
                            ? 'bg-neutral-100 text-neutral-900 ring-1 ring-neutral-300 font-medium'
                            : 'text-neutral-700 hover:bg-neutral-100 cursor-pointer'
                      }
                    `}
                  >
                    {cell.day}
                  </button>
                )
              })}
            </div>

            {/* Footer */}
            <div className="mt-2 pt-2 border-t border-neutral-200 flex gap-2">
              <button
                type="button"
                onClick={handleToday}
                className="flex-1 py-1.5 text-[12px] text-neutral-500 hover:bg-neutral-100 rounded-md transition-colors"
              >
                Hoje
              </button>
              <button
                type="button"
                onClick={handleClear}
                className="flex-1 py-1.5 text-[12px] text-neutral-500 hover:bg-neutral-100 rounded-md transition-colors"
              >
                Limpar
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

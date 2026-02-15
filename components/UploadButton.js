'use client'

import { useState, useEffect, useRef } from 'react'

export default function UploadButton({ onClick, loading = false, disabled = false, success = false, label = 'Upload' }) {
  const [state, setState] = useState('idle') // idle, loading, success
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  useEffect(() => {
    if (loading && state === 'idle') {
      setState('loading')
      setElapsedSeconds(0)
    }
    if (success && state === 'loading') {
      setState('success')
      const timer = setTimeout(() => {
        setState('idle')
        setElapsedSeconds(0)
      }, 2000)
      return () => clearTimeout(timer)
    }
    if (!loading && !success && state !== 'idle') {
      setState('idle')
      setElapsedSeconds(0)
    }
  }, [loading, success, state])

  // Timer to count elapsed seconds while loading
  useEffect(() => {
    if (state !== 'loading') return
    const interval = setInterval(() => {
      setElapsedSeconds(prev => prev + 1)
    }, 1000)
    return () => clearInterval(interval)
  }, [state])

  const handleClick = (e) => {
    e.preventDefault()
    if (disabled || state === 'loading') return
    onClick?.()
  }

  // Dynamic loading text based on elapsed time
  const getLoadingText = () => {
    if (elapsedSeconds < 3) return 'Enviando...'
    if (elapsedSeconds < 8) return 'Processando PDF...'
    if (elapsedSeconds < 15) return 'Extraindo transações...'
    if (elapsedSeconds < 25) return 'Analisando com IA...'
    if (elapsedSeconds < 40) return 'Quase lá...'
    return 'Finalizando...'
  }

  return (
    <>
      <style jsx>{`
        .upload-btn {
          --bg: #1e2132;
          --text-color: #f8f9fc;
          --arrow-color: #f8f9fc;
          --success-bg: #16a34a;
          display: inline-flex;
          align-items: center;
          overflow: hidden;
          background: var(--bg);
          border-radius: 30px;
          box-shadow: 0 2px 8px -1px rgba(10, 22, 50, 0.24);
          transition: transform 0.2s ease, box-shadow 0.2s ease, opacity 0.2s ease;
          cursor: pointer;
          user-select: none;
          min-width: 220px;
          height: 52px;
          position: relative;
        }
        .upload-btn:active:not(.disabled):not(.loading) {
          transform: scale(0.96);
          box-shadow: 0 1px 4px -1px rgba(10, 22, 50, 0.24);
        }
        .upload-btn.disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
        .upload-btn.loading {
          cursor: wait;
        }
        .upload-btn.success {
          background: var(--success-bg);
        }

        .upload-btn .btn-content {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 0 24px 0 28px;
          width: 100%;
          justify-content: center;
        }

        .upload-btn .btn-label {
          font-size: 15px;
          font-weight: 500;
          line-height: 24px;
          color: var(--text-color);
          white-space: nowrap;
          transition: opacity 0.3s ease;
        }

        /* Spinner */
        .upload-spinner {
          width: 20px;
          height: 20px;
          border: 2.5px solid rgba(255, 255, 255, 0.2);
          border-top-color: #fff;
          border-radius: 50%;
          animation: upload-spin 0.7s linear infinite;
          flex-shrink: 0;
        }

        @keyframes upload-spin {
          to { transform: rotate(360deg); }
        }

        /* Pulse dot animation for loading text */
        .upload-dots::after {
          content: '';
          animation: upload-dots 1.5s steps(4, end) infinite;
        }

        @keyframes upload-dots {
          0% { content: ''; }
          25% { content: '.'; }
          50% { content: '..'; }
          75% { content: '...'; }
          100% { content: ''; }
        }

        /* Progress bar */
        .upload-progress-bar {
          position: absolute;
          bottom: 0;
          left: 0;
          height: 3px;
          background: rgba(255, 255, 255, 0.35);
          border-radius: 0 0 30px 30px;
          animation: upload-progress-indeterminate 2s ease-in-out infinite;
        }

        @keyframes upload-progress-indeterminate {
          0% { width: 0%; left: 0%; }
          50% { width: 60%; left: 20%; }
          100% { width: 0%; left: 100%; }
        }

        /* Arrow icon */
        .upload-arrow {
          width: 18px;
          height: 18px;
          flex-shrink: 0;
          stroke: var(--arrow-color);
          fill: none;
          stroke-width: 2px;
          stroke-linecap: round;
          stroke-linejoin: round;
          transition: transform 0.3s ease;
        }
        .upload-btn:hover:not(.disabled):not(.loading) .upload-arrow {
          transform: translateY(-2px);
        }

        /* Checkmark icon */
        .upload-check {
          width: 20px;
          height: 20px;
          flex-shrink: 0;
          stroke: var(--arrow-color);
          fill: none;
          stroke-width: 2.5px;
          stroke-linecap: round;
          stroke-linejoin: round;
          animation: upload-check-draw 0.4s ease forwards;
        }

        @keyframes upload-check-draw {
          0% { stroke-dasharray: 24; stroke-dashoffset: 24; }
          100% { stroke-dasharray: 24; stroke-dashoffset: 0; }
        }

        /* Elapsed timer */
        .upload-timer {
          font-size: 12px;
          font-weight: 400;
          color: rgba(255, 255, 255, 0.5);
          font-variant-numeric: tabular-nums;
          min-width: 28px;
          text-align: right;
        }
      `}</style>

      <button
        onClick={handleClick}
        className={`upload-btn ${state} ${disabled ? 'disabled' : ''}`}
        disabled={disabled}
        type="button"
      >
        <div className="btn-content">
          {state === 'idle' && (
            <>
              <svg className="upload-arrow" viewBox="0 0 24 24">
                <path d="M5 12 L12 5 L19 12" />
                <path d="M12 5 L12 19" />
              </svg>
              <span className="btn-label">{label}</span>
            </>
          )}

          {state === 'loading' && (
            <>
              <div className="upload-spinner" />
              <span className="btn-label">{getLoadingText()}</span>
              {elapsedSeconds >= 5 && (
                <span className="upload-timer">{elapsedSeconds}s</span>
              )}
            </>
          )}

          {state === 'success' && (
            <>
              <svg className="upload-check" viewBox="0 0 24 24">
                <path d="M4 12 L10 18 L20 6" />
              </svg>
              <span className="btn-label">Concluído</span>
            </>
          )}
        </div>

        {state === 'loading' && (
          <div className="upload-progress-bar" />
        )}
      </button>
    </>
  )
}

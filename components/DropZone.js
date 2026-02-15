'use client'

import { useRef, useState } from 'react'
import { Upload, FileText, X } from 'lucide-react'

export default function DropZone({ onFileSelect, accept = '.pdf,.ofx,.qfx', file, formats = [] }) {
  const inputRef = useRef(null)
  const [isDragOver, setIsDragOver] = useState(false)

  const handleDragOver = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }

  const handleDragLeave = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    const droppedFile = e.dataTransfer.files?.[0]
    if (droppedFile) {
      onFileSelect(droppedFile)
    }
  }

  const handleChange = (e) => {
    const selectedFile = e.target.files?.[0]
    if (selectedFile) {
      onFileSelect(selectedFile)
    }
  }

  const handleClear = (e) => {
    e.stopPropagation()
    onFileSelect(null)
    if (inputRef.current) {
      inputRef.current.value = ''
    }
  }

  const getFileExtension = (filename) => {
    return filename?.split('.').pop()?.toLowerCase() || ''
  }

  const getFileTypeBadge = (filename) => {
    const ext = getFileExtension(filename)
    if (ext === 'ofx' || ext === 'qfx') {
      return (
        <span className="px-2.5 py-1 bg-emerald-50 text-emerald-700 text-xs rounded-full font-medium">
          Parser determinisitco
        </span>
      )
    }
    return (
      <span className="px-2.5 py-1 bg-amber-50 text-amber-700 text-xs rounded-full font-medium">
        Processamento com IA
      </span>
    )
  }

  return (
    <div className="space-y-3">
      <div
        className={`
          relative border-2 border-dashed rounded-xl py-12 px-6 text-center cursor-pointer
          transition-all duration-200 ease-in-out
          ${isDragOver
            ? 'border-neutral-500 bg-neutral-100/80 scale-[1.01]'
            : file
              ? 'border-emerald-300 bg-emerald-50/20'
              : 'border-neutral-300 hover:border-neutral-400 hover:bg-neutral-50/50'
          }
        `}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
      >
        <input
          type="file"
          ref={inputRef}
          className="hidden"
          accept={accept}
          onChange={handleChange}
        />

        {file ? (
          <div className="flex flex-col items-center gap-3">
            <div className="relative">
              <FileText size={44} className="text-emerald-500" strokeWidth={1.5} />
              <button
                onClick={handleClear}
                className="absolute -top-1 -right-1 p-0.5 bg-neutral-200 rounded-full hover:bg-neutral-300 transition-colors"
                title="Remover arquivo"
              >
                <X size={12} className="text-neutral-600" />
              </button>
            </div>
            <div>
              <p className="font-medium text-neutral-900 text-sm">{file.name}</p>
              <p className="text-xs text-neutral-500 mt-1">
                {(file.size / 1024).toFixed(0)} KB
              </p>
            </div>
            {getFileTypeBadge(file.name)}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <div className="p-3 bg-neutral-100 rounded-xl">
              <Upload size={28} className="text-neutral-400" strokeWidth={1.5} />
            </div>
            <div>
              <p className="font-medium text-neutral-700">
                Arraste o arquivo aqui para importar
              </p>
              <p className="text-sm text-neutral-400 mt-1">
                ou{' '}
                <span className="text-neutral-900 font-medium underline underline-offset-2 decoration-neutral-300">
                  selecione um arquivo
                </span>
              </p>
            </div>
          </div>
        )}
      </div>

      {formats.length > 0 && !file && (
        <div className="flex gap-2 justify-center">
          {formats.map((f, i) => (
            <span key={i} className={`px-2.5 py-1 text-xs rounded-full font-medium ${f.color}`}>
              {f.ext} {f.label && `(${f.label})`}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

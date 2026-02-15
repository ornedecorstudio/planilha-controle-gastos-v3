'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Plus } from 'lucide-react'

export default function Header() {
  const pathname = usePathname()

  const links = [
    { href: '/', label: 'Dashboard' },
    { href: '/faturas', label: 'Faturas' },
    { href: '/extratos', label: 'Extratos' },
    { href: '/reconciliacao', label: 'Reconciliacao' },
  ]

  return (
    <header className="bg-white border-b border-neutral-200">
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex items-center gap-6 h-14">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2 shrink-0">
            <span className="text-[14px] font-semibold text-neutral-900 tracking-tight">
              ORNE
            </span>
            <span className="hidden sm:inline text-neutral-400 text-[12px] font-normal">
              Categorizador
            </span>
          </Link>

          {/* Separador */}
          <div className="hidden md:block w-px h-5 bg-neutral-200" />

          {/* Navegacao desktop */}
          <nav className="hidden md:flex items-center gap-1 flex-1">
            {links.map(link => (
              <Link
                key={link.href}
                href={link.href}
                className={`
                  px-3 py-1.5 text-[13px] transition-colors relative
                  ${pathname === link.href
                    ? 'text-neutral-900 font-medium'
                    : 'text-neutral-500 hover:text-neutral-700'
                  }
                `}
              >
                {link.label}
                {pathname === link.href && (
                  <span className="absolute bottom-[-13px] left-0 right-0 h-[2px] bg-neutral-900" />
                )}
              </Link>
            ))}
          </nav>

          {/* Acao principal */}
          <Link
            href="/upload"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-neutral-900 text-white text-[13px] font-medium rounded-md hover:bg-neutral-800 transition-colors ml-auto"
          >
            <Plus size={14} strokeWidth={1.5} />
            <span className="hidden sm:inline">Nova fatura</span>
          </Link>
        </div>

        {/* Navegacao mobile */}
        <nav className="md:hidden flex items-center gap-1 pb-2 -mx-1 overflow-x-auto">
          {links.map(link => (
            <Link
              key={link.href}
              href={link.href}
              className={`
                px-3 py-1 text-[13px] whitespace-nowrap transition-colors relative
                ${pathname === link.href
                  ? 'text-neutral-900 font-medium'
                  : 'text-neutral-500 hover:text-neutral-700'
                }
              `}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  )
}

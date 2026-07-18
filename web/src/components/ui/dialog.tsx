import { useEffect, useRef } from 'react'
import { X } from '@phosphor-icons/react'

/**
 * Minimal accessible modal: overlay click + Escape close, focus moves in on
 * open and returns on close, body scroll locked while open.
 */
export function Dialog({
  open,
  onClose,
  label,
  children,
}: {
  open: boolean
  onClose: () => void
  label: string
  children: React.ReactNode
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    restoreFocus.current = document.activeElement as HTMLElement
    panelRef.current?.focus()
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = ''
      window.removeEventListener('keydown', onKey)
      restoreFocus.current?.focus()
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
      role="presentation"
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="relative max-h-[85vh] w-full max-w-xl overflow-y-auto overscroll-contain rounded-lg border border-foil/25 bg-background text-foreground shadow-2xl focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 z-10 rounded-md p-1.5 text-foreground/60 transition-colors hover:bg-white/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foil"
        >
          <X size={16} weight="bold" aria-hidden="true" />
        </button>
        {children}
      </div>
    </div>
  )
}

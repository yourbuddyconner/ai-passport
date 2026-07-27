import { useEffect, useMemo, useState } from 'react'
import { CaretLeft, CaretRight } from '@phosphor-icons/react'

/**
 * Client-side pagination over an already-loaded list. Clamps the page when
 * the list shrinks (session deletes, refreshes) so the pager never strands
 * the user on an empty page.
 */
export function usePager<T>(items: T[], pageSize: number) {
  const [page, setPage] = useState(0)
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize))
  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1)
  }, [page, pageCount])
  const clamped = Math.min(page, pageCount - 1)
  const pageItems = useMemo(
    () => items.slice(clamped * pageSize, (clamped + 1) * pageSize),
    [items, clamped, pageSize],
  )
  return {
    pageItems,
    page: clamped,
    pageCount,
    setPage,
    start: items.length === 0 ? 0 : clamped * pageSize + 1,
    end: Math.min(items.length, (clamped + 1) * pageSize),
    total: items.length,
  }
}

export function PagerControls({
  pager,
  label,
}: {
  pager: ReturnType<typeof usePager>
  label: string
}) {
  if (pager.pageCount <= 1) return null
  return (
    <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
      <span className="font-mono text-xs tabular-nums text-muted-foreground">
        {pager.start}–{pager.end} of {pager.total.toLocaleString()} {label}
      </span>
      <span className="flex items-center gap-1">
        <button
          aria-label="Previous page"
          disabled={pager.page === 0}
          className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foil"
          onClick={() => pager.setPage(pager.page - 1)}
        >
          <CaretLeft size={14} weight="bold" aria-hidden="true" />
        </button>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {pager.page + 1}/{pager.pageCount}
        </span>
        <button
          aria-label="Next page"
          disabled={pager.page >= pager.pageCount - 1}
          className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foil"
          onClick={() => pager.setPage(pager.page + 1)}
        >
          <CaretRight size={14} weight="bold" aria-hidden="true" />
        </button>
      </span>
    </div>
  )
}

const ORDER: Array<[string, string, string]> = [
  ['shipped', 'Shipped', 'bg-emerald-500'],
  ['landed', 'Landed', 'bg-emerald-400'],
  ['green', 'Verified', 'bg-lime-400'],
  ['committed', 'Committed', 'bg-sky-400'],
  ['research', 'Research', 'bg-violet-400'],
  ['red', 'Ended red', 'bg-rose-400'],
  ['unverified', 'Unverified', 'bg-zinc-400'],
  ['trivial', 'Trivial', 'bg-zinc-300'],
]

export function OutcomeBar({ outcomes }: { outcomes: Record<string, number> }) {
  const parts = ORDER.filter(([k]) => (outcomes[k] ?? 0) > 0)
  const total = parts.reduce((a, [k]) => a + outcomes[k], 0)
  if (total === 0) return null
  return (
    <div>
      <div className="flex h-2 w-full overflow-hidden rounded-full">
        {parts.map(([k, , color]) => (
          <div key={k} className={color} style={{ width: `${(outcomes[k] / total) * 100}%` }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {parts.map(([k, label, color]) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${color}`} />
            {label} {outcomes[k]}
          </span>
        ))}
      </div>
    </div>
  )
}

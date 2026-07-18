import { SealCheck } from '@phosphor-icons/react'
import type { Achievement } from '@/lib/api'

/**
 * Achievement stamps, passport-endorsement style. Earned ones are inked;
 * locked ones are dashed outlines with progress — the incentive to feed the
 * passport more traces.
 */
export function Endorsements({
  achievements,
  showLocked = true,
}: {
  achievements: Achievement[]
  showLocked?: boolean
}) {
  const shown = showLocked ? achievements : achievements.filter((a) => a.earned)
  if (shown.length === 0) return null
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {shown.map((a, i) => (
        <li
          key={a.id}
          title={a.description}
          className={
            a.earned
              ? `rounded-lg border-2 p-3 ${i % 2 ? 'border-destructive/70 text-destructive' : 'border-verify/70 text-verify'}`
              : 'rounded-lg border-2 border-dashed border-border p-3 text-muted-foreground/70'
          }
          style={a.earned ? { transform: `rotate(${i % 2 ? 1.2 : -1.2}deg)` } : undefined}
        >
          <div className="flex items-center gap-1.5">
            {a.earned && (
              <SealCheck size={15} weight="duotone" aria-hidden="true" className="shrink-0" />
            )}
            <span className="truncate font-mono text-[11px] font-bold uppercase tracking-wider">
              {a.name}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-snug opacity-80">{a.description}</p>
          {!a.earned && a.progress && (
            <p className="mt-1.5 font-mono text-[10px] tabular-nums">
              {a.progress.current >= 1000
                ? `${Math.round((a.progress.current / a.progress.target) * 100)}%`
                : `${a.progress.current} / ${a.progress.target}`}
            </p>
          )}
        </li>
      ))}
    </ul>
  )
}

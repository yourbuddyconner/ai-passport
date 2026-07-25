import { GradeSeal } from '@/components/GradeSeal'
import type { LeaderboardEntry } from '@/lib/api'

/** Shared ranked table for the global leaderboard and individual ladders. */
export function RankTable({
  entries,
  emptyMessage = 'No ranked entries yet.',
}: {
  entries: LeaderboardEntry[]
  emptyMessage?: string
}) {
  if (entries.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{emptyMessage}</p>
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="px-3 py-2 font-medium">
              Rank
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Name
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Verified score
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Sessions
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Lines shipped
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.slug} className="border-b border-border/60 last:border-0 hover:bg-muted/30">
              <td className="px-3 py-2 font-mono tabular-nums text-muted-foreground">#{e.rank}</td>
              <td className="px-3 py-2">
                <a
                  href={`/p/${e.slug}`}
                  className="flex items-center gap-2 font-medium text-card-foreground hover:text-foil hover:underline"
                >
                  <GradeSeal score={e.verifiedScore} grade={e.grade} size={28} />
                  <span className="truncate">{e.name}</span>
                </a>
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{e.verifiedScore}</td>
              <td className="px-3 py-2 text-right tabular-nums">{e.sessions}</td>
              <td className="px-3 py-2 text-right tabular-nums">{e.locAdded.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

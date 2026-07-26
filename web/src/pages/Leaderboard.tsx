import { useEffect, useState } from 'react'
import { ArrowLeft, CheckCircle, Copy, Lightning, Trophy } from '@phosphor-icons/react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { RankTable } from '@/components/RankTable'
import { getLeaderboard, type LeaderboardView, type Spotlight } from '@/lib/api'

const TRACE_FINDER_CMD = 'ls ~/.claude/projects/*/*.jsonl ~/.codex/sessions/*/*/*/*.jsonl'
const THIN_THRESHOLD = 3

function SpotlightCard({
  icon: Icon,
  label,
  spotlight,
  unit,
}: {
  icon: typeof Trophy
  label: string
  spotlight: Spotlight
  unit: string
}) {
  return (
    <a
      href={`/p/${spotlight.slug}`}
      className="page-rise flex items-center gap-3 rounded-md border border-border bg-card p-4 text-card-foreground transition-colors hover:border-foil/60"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-primary">
        <Icon size={18} weight="duotone" aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">{label}</p>
        <p className="truncate font-semibold">{spotlight.name}</p>
        <p className="text-xs text-muted-foreground">
          {spotlight.value.toLocaleString()} {unit}
        </p>
      </div>
    </a>
  )
}

export function Leaderboard() {
  const [data, setData] = useState<LeaderboardView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    getLeaderboard()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load the leaderboard'))
  }, [])

  const thin = !!data && data.entries.length < THIN_THRESHOLD
  const hasSpotlights = !!data && (data.spotlights.linesShipped || data.spotlights.concluded)

  return (
    <div className="mx-auto max-w-2xl px-4 py-14">
      <a
        href="/"
        className="mb-10 inline-flex items-center gap-2 text-sm text-foreground/70 transition-colors hover:text-foil"
      >
        <ArrowLeft size={16} aria-hidden="true" /> Back to AI Passport
      </a>

      <header className="page-rise mb-8 text-center">
        <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.35em] text-foreground/60">
          Global Rankings
        </p>
        <h1 className="foil text-4xl font-semibold tracking-tight">Leaderboard</h1>
        <p className="mt-3 text-sm text-foreground/80">
          Every rank is backed by enclave-attested sessions.
        </p>
      </header>

      {error && (
        <p aria-live="polite" className="mb-6 text-center text-sm text-destructive">
          {error}
        </p>
      )}

      {hasSpotlights && (
        <div className="page-rise mb-8 grid grid-cols-1 gap-3 sm:grid-cols-2" style={{ animationDelay: '80ms' }}>
          {data!.spotlights.linesShipped && (
            <SpotlightCard
              icon={Lightning}
              label="Lines shipped"
              spotlight={data!.spotlights.linesShipped}
              unit="lines added"
            />
          )}
          {data!.spotlights.concluded && (
            <SpotlightCard
              icon={CheckCircle}
              label="Most shipped or landed"
              spotlight={data!.spotlights.concluded}
              unit="sessions concluded"
            />
          )}
        </div>
      )}

      <Card className="page-rise guilloche" style={{ animationDelay: '140ms' }}>
        <CardContent className="p-4">
          {data ? (
            <RankTable entries={data.entries} emptyMessage="No listed passports yet — be the first." />
          ) : (
            !error && <p className="py-8 text-center text-sm text-muted-foreground">Loading the leaderboard…</p>
          )}
        </CardContent>
      </Card>

      {thin && (
        <Card className="page-rise guilloche mt-6" style={{ animationDelay: '200ms' }}>
          <CardHeader>
            <CardTitle>Start a ladder with your team</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              The leaderboard is just getting started. Grab your spot early — or make it a team
              thing: create a private ladder from your dashboard and invite teammates with a link.
            </p>
            <a
              href="/"
              className="inline-flex items-center text-sm font-medium text-foil underline-offset-2 hover:underline"
            >
              Go to your dashboard →
            </a>
            <div>
              <p className="mb-2 text-xs text-muted-foreground">
                No traces uploaded yet? Find your session files with:
              </p>
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/60 px-3 py-2">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-card-foreground">
                  {TRACE_FINDER_CMD}
                </code>
                <button
                  type="button"
                  className="shrink-0 text-muted-foreground transition-colors hover:text-foil"
                  onClick={() => {
                    void navigator.clipboard.writeText(TRACE_FINDER_CMD)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  }}
                  aria-label="Copy command"
                >
                  <Copy size={15} weight="duotone" aria-hidden="true" />
                </button>
              </div>
              {copied && <p className="mt-1 text-xs text-verify">Copied!</p>}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

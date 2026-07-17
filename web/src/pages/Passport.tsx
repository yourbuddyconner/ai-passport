import { useEffect, useState } from 'react'
import { ShieldCheck, Terminal, Cpu, Wrench, MessageSquare, Clock, CalendarDays, Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { fetchPassport, type PassportView } from '@/lib/api'

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function Stat({ icon: Icon, label, value }: { icon: typeof Cpu; label: string; value: string }) {
  return (
    <div className="flex flex-col items-center rounded-lg bg-muted p-4">
      <Icon className="mb-2 h-5 w-5 text-primary" />
      <span className="text-2xl font-bold tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}

const HARNESS_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex CLI',
}

export function Passport({ slug }: { slug: string }) {
  const [view, setView] = useState<PassportView | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchPassport(slug).then(setView).catch((e) => setError(e.message))
  }, [slug])

  if (error)
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        {error}
      </div>
    )
  if (!view)
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        Loading…
      </div>
    )

  const { passport, card } = view
  const maxTool = card.topTools[0]?.count ?? 1
  const range =
    card.firstActivity && card.lastActivity
      ? `${card.firstActivity.slice(0, 10)} → ${card.lastActivity.slice(0, 10)}`
      : '—'

  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <Card className="overflow-hidden">
        <div className="bg-gradient-to-r from-primary/20 to-transparent p-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-primary">
              <ShieldCheck className="h-6 w-6" />
              <span className="text-sm font-semibold uppercase tracking-widest">
                Verified AI Use
              </span>
            </div>
            <Badge className="text-sm">{card.grade}</Badge>
          </div>
          <h1 className="mt-4 text-3xl font-bold">{passport.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Fluency score <span className="font-semibold text-foreground">{card.score}/100</span> ·
            active {range}
          </p>
        </div>

        <CardContent className="space-y-8 p-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat icon={Terminal} label="sessions" value={String(card.totalSessions)} />
            <Stat icon={MessageSquare} label="messages" value={fmt(card.totalMessages)} />
            <Stat icon={Wrench} label="tool calls" value={fmt(card.totalToolCalls)} />
            <Stat icon={Zap} label="output tokens" value={fmt(card.totalOutputTokens)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Stat icon={Clock} label="active hours" value={String(card.activeHours)} />
            <Stat icon={CalendarDays} label="active days" value={String(card.activeDays)} />
          </div>

          <div>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Harnesses & Models
            </h2>
            <div className="flex flex-wrap gap-2">
              {card.harnesses.map((h) => (
                <Badge key={h}>{HARNESS_LABELS[h] ?? h}</Badge>
              ))}
              {card.models.map((m) => (
                <Badge key={m} variant="outline">
                  <Cpu className="mr-1 h-3 w-3" />
                  {m}
                </Badge>
              ))}
            </div>
          </div>

          {card.topTools.length > 0 && (
            <div>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Top Tools
              </h2>
              <div className="space-y-2">
                {card.topTools.map((t) => (
                  <div key={t.name} className="flex items-center gap-3 text-sm">
                    <span className="w-32 truncate font-mono text-xs">{t.name}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${(t.count / maxTool) * 100}%` }}
                      />
                    </div>
                    <span className="w-12 text-right tabular-nums text-muted-foreground">
                      {t.count}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Score Breakdown
            </h2>
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
              {Object.entries(card.scoreBreakdown).map(([k, v]) => (
                <div key={k} className="flex justify-between rounded-md bg-muted px-3 py-2">
                  <span className="text-muted-foreground">{k}</span>
                  <span className="tabular-nums">{v}</span>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <p className="mt-6 text-center text-xs text-muted-foreground">
        Format-verified: statistics computed server-side from genuine harness session traces.
        <br />
        <a href="/" className="text-primary hover:underline">
          Build your own AI Passport →
        </a>
      </p>
    </div>
  )
}

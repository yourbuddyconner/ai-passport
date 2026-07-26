import { useEffect, useState } from 'react'
import {
  FolderOpen,
  SealCheck,
  TerminalWindow,
  Wrench,
  Lightning,
  Clock,
  CalendarBlank,
  Cpu,
  Copy,
  ShareNetwork,
  XLogo,
  LinkedinLogo,
  WarningCircle,
  Robot,
  Timer,
  UsersThree,
  ArrowsClockwise,
  Sparkle,
  Stack,
  CirclesFour,
} from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { GradeSeal } from '@/components/GradeSeal'
import { TurnkeyBadge } from '@/components/TurnkeyBadge'
import { mrz } from '@/lib/mrz'
import { Endorsements } from '@/components/Endorsements'
import { LanguageBar } from '@/components/LanguageBar'
import { OutcomeBar } from '@/components/OutcomeBar'
import { fetchPassport, type PassportView } from '@/lib/api'
import { verifyProofSignature } from '@/lib/verify'
import { useCountUp } from '@/lib/useCountUp'

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

const HARNESS_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex CLI',
}

function Entry({
  icon: Icon,
  label,
  value,
  format = String,
}: {
  icon: typeof Cpu
  label: string
  value: number
  format?: (n: number) => string
}) {
  const shown = useCountUp(value, { initial: 0, duration: 900 })
  return (
    <div className="flex flex-col items-center rounded-md border border-border/70 bg-white/40 px-2 py-3">
      <Icon size={18} weight="duotone" className="mb-1.5 text-primary" aria-hidden="true" />
      <span className="text-xl font-bold tabular-nums text-card-foreground">{format(shown)}</span>
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </div>
  )
}

type VerifyState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; verified: number; failed: number; total: number }

export function Passport({ slug }: { slug: string }) {
  const [view, setView] = useState<PassportView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [verify, setVerify] = useState<VerifyState>({ status: 'idle' })
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    fetchPassport(slug)
      .then(setView)
      .catch((e) => setError(e.message))
  }, [slug])

  async function runVerification() {
    if (!view) return
    setVerify({ status: 'running' })
    const proofs = view.sessions.filter((s) => s.proof)
    let verified = 0
    let failed = 0
    for (const s of proofs) {
      if (s.proof && (await verifyProofSignature(s.proof))) verified++
      else failed++
    }
    setVerify({ status: 'done', verified, failed, total: proofs.length })
  }

  if (error)
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-muted-foreground">
        <p>{error}</p>
        <a href="/" className="text-sm text-foil hover:underline">
          Get Your Own AI Passport →
        </a>
      </div>
    )
  if (!view)
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        Opening the passport…
      </div>
    )

  const { passport, card } = view
  const [mrz1, mrz2] = mrz(passport.name, passport.slug, card.score, card.grade)
  const maxTool = card.topTools[0]?.count ?? 1
  const hasLanguages = Object.values(card.languages ?? {}).some((v) => v > 0)
  const hasOutcomes = Object.values(card.outcomes ?? {}).some((v) => v > 0)
  const showReuploadHint = card.concludedSessions === 0 && card.totalSessions > 0
  const workingStyleEntries: Array<{
    icon: typeof Cpu
    label: string
    value: number
    format?: (n: number) => string
  }> = [
    { icon: Robot, label: 'tool calls / prompt (median)', value: card.agenticity },
    { icon: Timer, label: 'longest run', value: card.longestRun },
    { icon: UsersThree, label: 'delegation calls', value: card.delegationCalls },
    { icon: ArrowsClockwise, label: 'red→green cycles', value: card.redGreenCycles },
    { icon: Sparkle, label: 'skills used', value: card.skills?.length ?? 0 },
    { icon: Stack, label: 'background tasks', value: card.backgroundTasks },
    { icon: CirclesFour, label: 'max concurrent sessions', value: card.maxConcurrentSessions },
  ].filter((e) => e.value > 0)
  const topCommandMix = [...(card.commandMix ?? [])]
    .sort((a, b) => b.share - a.share)
    .slice(0, 4)
  const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short' })
  const issued = card.firstActivity ? dateFmt.format(new Date(card.firstActivity)) : null
  const latest = card.lastActivity ? dateFmt.format(new Date(card.lastActivity)) : null
  const cardUrl = `${location.origin}/p/${passport.slug}`
  // Versioned share URL: busts X/Slack link-preview caches whenever the
  // stats change, so shares always unfurl with a current card image.
  const shareUrl = `${cardUrl}?v=${card.score}-${card.totalSessions}`
  const shareText = `My AI Passport: ${card.grade} — ${card.score}/100 fluency across ${card.totalSessions} enclave-verified coding sessions.`

  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <header className="page-rise mb-6 flex items-center justify-center gap-2">
        <SealCheck size={18} weight="duotone" className="text-foil" aria-hidden="true" />
        <span className="font-mono text-[11px] uppercase tracking-[0.35em] text-foreground/60">
          AI Passport · Verified AI Use
        </span>
      </header>

      {/* The open spread */}
      <div
        className="page-rise guilloche overflow-hidden rounded-lg border border-[#c8b88f]/40 bg-card text-card-foreground shadow-2xl"
        style={{ animationDelay: '100ms' }}
      >
        {/* Identity page */}
        <div className="flex items-start justify-between gap-6 p-7 pb-5">
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
              bearer / titulaire
            </p>
            <h1 className="mt-1 break-words text-4xl font-semibold">{passport.name}</h1>
            {(passport.company || passport.linkedin || passport.twitter) && (
              <div className="mt-1 flex items-center gap-2">
                {passport.company && (
                  <span className="text-sm text-muted-foreground">{passport.company}</span>
                )}
                {passport.linkedin && (
                  <a
                    href={`https://www.linkedin.com/in/${passport.linkedin}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="LinkedIn profile"
                    className="text-muted-foreground transition-colors hover:text-foil"
                  >
                    <LinkedinLogo size={16} weight="duotone" aria-hidden="true" />
                  </a>
                )}
                {passport.twitter && (
                  <a
                    href={`https://x.com/${passport.twitter}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="X profile"
                    className="text-muted-foreground transition-colors hover:text-foil"
                  >
                    <XLogo size={16} weight="duotone" aria-hidden="true" />
                  </a>
                )}
              </div>
            )}
            <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-[11px] uppercase">
              <div>
                <dt className="tracking-widest text-muted-foreground/80">first entry</dt>
                <dd className="mt-0.5 text-[13px]">{issued ?? '—'}</dd>
              </div>
              <div>
                <dt className="tracking-widest text-muted-foreground/80">latest entry</dt>
                <dd className="mt-0.5 text-[13px]">{latest ?? '—'}</dd>
              </div>
              <div>
                <dt className="tracking-widest text-muted-foreground/80">document no.</dt>
                <dd className="mt-0.5 text-[13px]" translate="no">
                  {passport.slug}
                </dd>
              </div>
              <div>
                <dt className="tracking-widest text-muted-foreground/80">grade</dt>
                <dd className="mt-0.5 text-[13px]">{card.grade}</dd>
              </div>
            </dl>
          </div>
          <GradeSeal score={card.score} grade={card.grade} />
        </div>

        {/* Harness stamps + model chips */}
        <div className="flex flex-wrap items-center gap-4 px-7 pb-5">
          {card.harnesses.map((h, i) => (
            <span
              key={h}
              className={`stamp stamp-in ${i % 2 ? 'text-destructive' : 'text-verify'}`}
              style={
                {
                  '--stamp-rotate': `${i % 2 ? 4 : -5}deg`,
                  animationDelay: `${450 + i * 250}ms`,
                } as React.CSSProperties
              }
            >
              {HARNESS_LABELS[h] ?? h}
              <br />
              <span className="font-normal opacity-80">admitted · {issued ?? '····'}</span>
            </span>
          ))}
          {card.models.map((m) => (
            <span
              key={m}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-white/40 px-2.5 py-1 font-mono text-[11px] text-muted-foreground"
              translate="no"
            >
              <Cpu size={12} weight="duotone" aria-hidden="true" />
              {m}
            </span>
          ))}
        </div>

        {/* Entries */}
        <div className="grid grid-cols-3 gap-2 px-7 pb-6 sm:grid-cols-6">
          <Entry icon={TerminalWindow} label="sessions" value={card.totalSessions} />
          <Entry icon={FolderOpen} label="repos" value={card.repositories} />
          <Entry icon={Wrench} label="tool calls" value={card.totalToolCalls} format={fmt} />
          <Entry icon={Lightning} label="tokens out" value={card.totalOutputTokens} format={fmt} />
          <Entry icon={Clock} label="hours" value={card.activeHours} />
          <Entry icon={CalendarBlank} label="days" value={card.activeDays} />
        </div>

        {card.achievements.some((a) => a.earned) && (
          <div className="px-7 pb-6">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
              endorsements · {card.achievements.filter((a) => a.earned).length} earned
            </p>
            <Endorsements achievements={card.achievements} showLocked={false} />
          </div>
        )}

        {/* Top tools */}
        {card.topTools.length > 0 && (
          <div className="px-7 pb-6">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
              tool endorsements
            </p>
            <div className="space-y-1.5">
              {card.topTools.slice(0, 6).map((t) => (
                <div key={t.name} className="flex items-center gap-3 text-sm">
                  <span className="w-32 truncate font-mono text-[11px]" translate="no">
                    {t.name}
                  </span>
                  <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[#ded2b4]">
                    <div
                      className="h-full rounded-full bg-primary/80"
                      style={{ width: `${(t.count / maxTool) * 100}%` }}
                    />
                  </div>
                  <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
                    {t.count}
                  </span>
                </div>
              ))}
            </div>
            {(topCommandMix.length > 0 || card.testShare > 0) && (
              <p className="mt-2 text-xs text-muted-foreground">
                {topCommandMix
                  .map((c) => `${c.category} ${Math.round(c.share * 100)}%`)
                  .join(' · ')}
                {topCommandMix.length > 0 && card.testShare > 0 ? ' · ' : ''}
                {card.testShare > 0 ? `test share ${Math.round(card.testShare * 100)}%` : ''}
              </p>
            )}
          </div>
        )}

        {/* Code */}
        {hasLanguages && (
          <div className="px-7 pb-6">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
              code
            </p>
            <LanguageBar languages={card.languages} />
            <p className="mt-2 text-xs text-muted-foreground">
              +{card.locAdded.toLocaleString()} / −{card.locRemoved.toLocaleString()} lines
            </p>
          </div>
        )}

        {/* Session outcomes */}
        {(hasOutcomes || showReuploadHint) && (
          <div className="px-7 pb-6">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
              session outcomes
            </p>
            {hasOutcomes && (
              <>
                <OutcomeBar outcomes={card.outcomes} />
                <p className="mt-2 text-xs text-muted-foreground">
                  {card.concludedSessions} sessions shipped or landed · {card.verifiedEditCycles}{' '}
                  verified edit cycles
                </p>
              </>
            )}
            {showReuploadHint && (
              <p className="mt-2 text-xs text-muted-foreground">
                re-upload sessions to count shipped work
              </p>
            )}
          </div>
        )}

        {/* Working style */}
        {workingStyleEntries.length > 0 && (
          <div className="px-7 pb-6">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
              working style
            </p>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              {workingStyleEntries.map((e) => (
                <Entry key={e.label} icon={e.icon} label={e.label} value={e.value} format={e.format} />
              ))}
            </div>
          </div>
        )}

        {/* Verification strip */}
        <div className="border-t border-border/70 bg-white/30 px-7 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm">
              {view.verification.enclaveSessions > 0 ? (
                <>
                  <SealCheck
                    size={17}
                    weight="duotone"
                    className="text-verify"
                    aria-hidden="true"
                  />
                  {view.verification.enclaveSessions} of {view.verification.totalSessions} session
                  {view.verification.totalSessions === 1 ? '' : 's'} verified in a secure enclave
                </>
              ) : (
                <>
                  <WarningCircle
                    size={17}
                    weight="duotone"
                    className="text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="text-muted-foreground">
                    Sessions were format-verified server-side
                  </span>
                </>
              )}
            </span>
            {view.verification.enclaveSessions > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void runVerification()}
                disabled={verify.status === 'running'}
              >
                {verify.status === 'running' ? 'Verifying…' : 'Verify Proofs'}
              </Button>
            )}
          </div>
          <p aria-live="polite" className="mt-1 text-sm">
            {verify.status === 'done' &&
              (verify.failed === 0 ? (
                <span className="text-verify">
                  ✓ All {verify.verified} enclave signatures verified in your browser
                </span>
              ) : (
                <span className="text-destructive">
                  ✗ {verify.failed} of {verify.total} proofs failed verification
                </span>
              ))}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Signatures are checked locally with WebCrypto — no server trust required.{' '}
            <a href="/about" className="text-primary underline-offset-2 hover:underline">
              How verification works →
            </a>
          </p>
        </div>

        {/* MRZ */}
        <div
          className="select-none overflow-x-auto border-t border-border/70 bg-[#efe7d3] px-7 py-3 font-mono text-[12px] leading-6 tracking-[0.14em] text-[#3a2f22]"
          aria-hidden="true"
          translate="no"
        >
          <div>{mrz1}</div>
          <div>{mrz2}</div>
        </div>
      </div>

      {/* Share row */}
      <div
        className="page-rise mt-6 flex flex-wrap items-center justify-center gap-3"
        style={{ animationDelay: '250ms' }}
      >
        <Button
          variant="cover"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(cardUrl)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          <Copy size={15} weight="duotone" aria-hidden="true" /> {copied ? 'Copied!' : 'Copy Link'}
        </Button>
        <Button
          variant="cover"
          size="sm"
          onClick={() =>
            window.open(
              `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl)}`,
              '_blank',
              'noopener',
            )
          }
        >
          <XLogo size={15} weight="duotone" aria-hidden="true" /> Share on X
        </Button>
        {typeof navigator.share === 'function' && (
          <Button
            variant="cover"
            size="sm"
            onClick={() =>
              void navigator
                .share({ title: 'AI Passport', text: shareText, url: shareUrl })
                .catch(() => {})
            }
          >
            <ShareNetwork size={15} weight="duotone" aria-hidden="true" /> Share…
          </Button>
        )}
      </div>

      <div
        className="page-rise mt-10 flex flex-col items-center gap-3"
        style={{ animationDelay: '350ms' }}
      >
        <TurnkeyBadge />
        <p className="text-center text-xs text-foreground/60">
          Statistics computed from genuine harness session traces.{' '}
          <a href="/" className="text-foil hover:underline">
            Get Your Own AI Passport →
          </a>
        </p>
        <a href="/leaderboard" className="text-xs text-foreground/60 hover:text-foil hover:underline">
          See the leaderboard →
        </a>
      </div>
    </div>
  )
}

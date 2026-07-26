import { useCallback, useEffect, useRef, useState } from 'react'
import {
  FolderOpen,
  Trash,
  UploadSimple,
  FileCode,
  CheckCircle,
  XCircle,
  Copy,
  ArrowSquareOut,
  LockKey,
  SignOut,
  SealCheck,
  TerminalWindow,
  Wrench,
  Lightning,
  CalendarBlank,
} from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { TurnkeyBadge } from '@/components/TurnkeyBadge'
import { VaultModal } from '@/components/VaultModal'
import { Endorsements } from '@/components/Endorsements'
import { GradeSeal } from '@/components/GradeSeal'
import { mrz } from '@/lib/mrz'
import {
  createLadder,
  deleteSession,
  logout,
  setListed,
  uploadTraceAsOwner,
  type Me,
  type MyLadder,
  type UploadResult,
} from '@/lib/api'
import { useCountUp } from '@/lib/useCountUp'

const PRIDE_PROMPT_DISMISSED_KEY = 'lb-prompt-dismissed'

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

const HARNESS_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex CLI',
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

function StatTile({
  icon: Icon,
  label,
  value,
  format = String,
}: {
  icon: typeof Lightning
  label: string
  value: number
  format?: (n: number) => string
}) {
  const shown = useCountUp(value)
  return (
    <div className="flex flex-col items-center rounded-md bg-card p-4 text-card-foreground">
      <Icon size={20} weight="duotone" className="mb-2 text-primary" aria-hidden="true" />
      <span key={value} className="stat-bump text-2xl font-bold tabular-nums">
        {format(shown)}
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}

export function Dashboard({
  me,
  onRefresh,
  onSignOut,
}: {
  me: Me
  onRefresh: () => void
  onSignOut: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [results, setResults] = useState<Array<UploadResult & { key: string }>>([])
  const [dragging, setDragging] = useState(false)
  const [copied, setCopied] = useState(false)
  const [vaultOpen, setVaultOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const busyRef = useRef(false)

  // Listed toggle
  const [listedBusy, setListedBusy] = useState(false)
  const [listedError, setListedError] = useState<string | null>(null)

  // Pride-moment prompt: shown once, after a batch upload lands ≥1 accepted
  // non-duplicate result while the passport is still unlisted.
  const [pridePromptPending, setPridePromptPending] = useState(false)
  const [showPridePrompt, setShowPridePrompt] = useState(false)

  // Your ladders card
  const [ladderName, setLadderName] = useState('')
  const [ladderBusy, setLadderBusy] = useState(false)
  const [ladderError, setLadderError] = useState<string | null>(null)
  const [copiedLadderSlug, setCopiedLadderSlug] = useState<string | null>(null)

  const cardUrl = `${location.origin}/p/${me.passport.slug}`
  const [mrz1, mrz2] = mrz(me.user.displayName, me.passport.slug, me.card.score, me.card.grade)

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      if (busyRef.current) return
      busyRef.current = true
      setBusy(true)
      const batch = Array.from(files)
      setProgress({ done: 0, total: batch.length })
      let anyAccepted = false
      try {
        for (const [i, file] of batch.entries()) {
          // One bad file must never kill the batch or wedge the uploader.
          let result: UploadResult
          try {
            result = await uploadTraceAsOwner(me.passport.id, file)
          } catch (e) {
            result = {
              fileName: file.name,
              ok: false,
              error: e instanceof Error ? e.message : 'upload failed — try this file again',
            }
          }
          setResults((prev) => [{ ...result, key: `${file.name}-${Date.now()}` }, ...prev])
          setProgress({ done: i + 1, total: batch.length })
          // Refresh after every accepted trace so the stats climb file by file.
          if (result.ok && !result.duplicate) {
            anyAccepted = true
            onRefresh()
          }
        }
      } finally {
        setBusy(false)
        busyRef.current = false
        setProgress(null)
        // Defer the pride-moment prompt decision to the effect below, which
        // runs once fresh `me` data (post-upload rank/listed state) lands.
        if (anyAccepted) setPridePromptPending(true)
      }
    },
    [me.passport.id, onRefresh],
  )

  // Fires once the batch above has finished and `me` has been refetched at
  // least once since — evaluates the pride-moment prompt against fresh data.
  useEffect(() => {
    if (!pridePromptPending) return
    setPridePromptPending(false)
    if (!me.listed && localStorage.getItem(PRIDE_PROMPT_DISMISSED_KEY) !== '1') {
      setShowPridePrompt(true)
    }
  }, [me, pridePromptPending])

  async function handleToggleListed() {
    setListedBusy(true)
    setListedError(null)
    try {
      await setListed(me.passport.id, !me.listed)
      onRefresh()
    } catch (e) {
      setListedError(e instanceof Error ? e.message : 'failed to update leaderboard listing')
    } finally {
      setListedBusy(false)
    }
  }

  function dismissPridePrompt() {
    localStorage.setItem(PRIDE_PROMPT_DISMISSED_KEY, '1')
    setShowPridePrompt(false)
  }

  async function acceptPridePrompt() {
    localStorage.setItem(PRIDE_PROMPT_DISMISSED_KEY, '1')
    setShowPridePrompt(false)
    try {
      await setListed(me.passport.id, true)
      onRefresh()
    } catch (e) {
      setListedError(e instanceof Error ? e.message : 'failed to update leaderboard listing')
    }
  }

  async function handleCreateLadder() {
    const name = ladderName.trim()
    if (!name) return
    setLadderBusy(true)
    setLadderError(null)
    try {
      await createLadder(name, me.passport.id)
      setLadderName('')
      onRefresh()
    } catch (e) {
      setLadderError(e instanceof Error ? e.message : 'failed to create ladder')
    } finally {
      setLadderBusy(false)
    }
  }

  function copyInviteLink(ladder: MyLadder) {
    void navigator.clipboard.writeText(`${location.origin}/l/${ladder.slug}?join=${ladder.inviteCode}`)
    setCopiedLadderSlug(ladder.slug)
    setTimeout(() => setCopiedLadderSlug((s) => (s === ladder.slug ? null : s)), 1500)
  }

  useEffect(() => {
    let depth = 0
    const onDragEnter = (e: DragEvent) => {
      e.preventDefault()
      if (e.dataTransfer?.types.includes('Files')) {
        depth++
        setDragging(true)
      }
    }
    const onDragOver = (e: DragEvent) => e.preventDefault()
    const onDragLeave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      depth = 0
      setDragging(false)
      if (e.dataTransfer?.files.length) void handleFiles(e.dataTransfer.files)
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [handleFiles])

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <div className="mb-8 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <SealCheck size={16} weight="duotone" className="text-foil" aria-hidden="true" />
          <span className="font-mono text-[11px] uppercase tracking-[0.3em] text-foreground/60">
            AI Passport
          </span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            await logout()
            onSignOut()
          }}
        >
          <SignOut size={15} weight="duotone" aria-hidden="true" /> Sign Out
        </Button>
      </div>

      {/* Identity page */}
      <div className="page-rise guilloche overflow-hidden rounded-lg border border-[#c8b88f]/40 bg-card text-card-foreground shadow-xl">
        <div className="flex items-start justify-between gap-6 p-6">
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
              bearer / titulaire
            </p>
            <h1 className="mt-1 break-words text-3xl font-semibold">{me.user.displayName}</h1>
            {me.user.title && (
              <p className="mt-0.5 text-sm text-muted-foreground">{me.user.title}</p>
            )}
            <p className="mt-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              document no. <span translate="no">{me.passport.slug}</span>
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <GradeSeal score={me.card.score} grade={me.card.grade} size={84} />
            <button
              onClick={() => setVaultOpen(true)}
              aria-label="Inspect the vault"
              title="Something is protecting your traces…"
              className="group rounded-md p-1 text-muted-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foil"
            >
              <LockKey
                size={17}
                weight="duotone"
                className="transition-transform group-hover:-rotate-12 group-hover:scale-110"
                aria-hidden="true"
              />
            </button>
          </div>
        </div>
        <div
          className="select-none overflow-x-auto border-t border-border/70 bg-[#efe7d3] px-6 py-2.5 font-mono text-[11px] leading-5 tracking-[0.14em] text-[#3a2f22]"
          aria-hidden="true"
          translate="no"
        >
          <div>{mrz1}</div>
          <div>{mrz2}</div>
        </div>
      </div>

      <VaultModal
        open={vaultOpen}
        onClose={() => setVaultOpen(false)}
        creds={{ id: me.passport.id, name: me.user.displayName }}
      />

      {/* Stats */}
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatTile icon={TerminalWindow} label="sessions" value={me.card.totalSessions} />
        <StatTile icon={FolderOpen} label="repos" value={me.card.repositories} />
        <StatTile icon={Wrench} label="tool calls" value={me.card.totalToolCalls} format={fmt} />
        <StatTile icon={Lightning} label="tokens out" value={me.card.totalOutputTokens} format={fmt} />
        <StatTile icon={CalendarBlank} label="active days" value={me.card.activeDays} />
      </div>

      {/* Leaderboard listing */}
      <Card className="mt-5">
        <CardHeader>
          <CardTitle>Leaderboard</CardTitle>
          <CardDescription>
            {me.listed
              ? 'Your card is visible on the public leaderboard.'
              : 'List your passport to show up on the public leaderboard.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <div className="text-sm">
            {me.listed ? (
              <p>
                <span className="font-semibold tabular-nums">#{me.globalRank ?? '—'}</span> of{' '}
                <span className="tabular-nums">{me.listedCount}</span> on the{' '}
                <a href="/leaderboard" className="text-foil hover:underline">
                  leaderboard
                </a>
              </p>
            ) : (
              <p className="text-muted-foreground">
                You'd be{' '}
                <span className="font-semibold tabular-nums text-card-foreground">
                  #{me.rankIfListed}
                </span>{' '}
                of <span className="tabular-nums">{me.listedCount + 1}</span> if listed
              </p>
            )}
            {listedError && <p className="mt-1 text-xs text-destructive">{listedError}</p>}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={me.listed}
            aria-label={me.listed ? 'Unlist from the leaderboard' : 'List on the leaderboard'}
            disabled={listedBusy}
            onClick={() => void handleToggleListed()}
            className={`relative h-7 w-12 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foil disabled:opacity-50 ${
              me.listed ? 'bg-primary' : 'bg-muted'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${
                me.listed ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </CardContent>
      </Card>

      {/* Upload */}
      <Card className="mt-5">
        <CardHeader>
          <CardTitle>Add Sessions</CardTitle>
          <CardDescription>
            Claude Code traces live in{' '}
            <code className="text-xs" translate="no">
              ~/.claude/projects/
            </code>
            , Codex traces in{' '}
            <code className="text-xs" translate="no">
              ~/.codex/sessions/
            </code>
            . Encrypted in your browser before upload.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            role="button"
            tabIndex={0}
            aria-label="Choose trace files to upload"
            className={`flex cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed p-8 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foil ${
              dragging ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/60'
            }`}
            onClick={() => fileInput.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                fileInput.current?.click()
              }
            }}
          >
            <UploadSimple
              size={26}
              weight="duotone"
              className="mb-2 text-muted-foreground"
              aria-hidden="true"
            />
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {busy
                ? progress && progress.total > 1
                  ? `Sealing & uploading… ${progress.done} of ${progress.total}`
                  : 'Sealing & uploading…'
                : 'Drop .jsonl traces anywhere, or click to browse'}
            </p>
            <input
              ref={fileInput}
              type="file"
              accept=".jsonl,.json,.txt"
              multiple
              className="hidden"
              onChange={(e) => e.target.files && void handleFiles(e.target.files)}
            />
          </div>

          {showPridePrompt && (
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-foil/40 bg-foil/10 px-4 py-3 text-sm">
              <p className="min-w-[200px] flex-1 text-card-foreground">
                You'd be <strong>#{me.rankIfListed}</strong> of <strong>{me.listedCount + 1}</strong>{' '}
                on the leaderboard — list your passport?
              </p>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" onClick={() => void acceptPridePrompt()}>
                  List me
                </Button>
                <Button size="sm" variant="ghost" onClick={dismissPridePrompt}>
                  Not now
                </Button>
              </div>
            </div>
          )}

          {results.length > 0 && (
            <ul className="space-y-2" aria-live="polite">
              {results.map((r) => (
                <li
                  key={r.key}
                  className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm"
                >
                  {r.ok ? (
                    <CheckCircle
                      size={16}
                      weight="duotone"
                      className="shrink-0 text-verify"
                      aria-hidden="true"
                    />
                  ) : (
                    <XCircle
                      size={16}
                      weight="duotone"
                      className="shrink-0 text-destructive"
                      aria-hidden="true"
                    />
                  )}
                  <FileCode
                    size={16}
                    weight="duotone"
                    className="shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 truncate">{r.fileName}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {r.ok
                      ? r.duplicate
                        ? 'duplicate — skipped'
                        : `${r.reprocessed ? 'reprocessed · ' : ''}${r.harness} · ${r.messageCount} msgs · ${r.toolCallCount} tools${
                            r.verification === 'enclave'
                              ? r.encryptedInBrowser
                                ? ' · end-to-end encrypted'
                                : ' · enclave-verified'
                              : ''
                          }`
                      : r.error}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Endorsements */}
      <Card className="mt-5">
        <CardHeader>
          <CardTitle>
            Endorsements{' '}
            <span className="ml-1 font-sans text-sm font-normal text-muted-foreground tabular-nums">
              {me.card.achievements.filter((a) => a.earned).length} of {me.card.achievements.length}
            </span>
          </CardTitle>
          <CardDescription>
            Earned from your verified sessions. Upload more traces to fill the page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Endorsements achievements={me.card.achievements} />
        </CardContent>
      </Card>

      {/* Session ledger */}
      {me.sessions.length > 0 && (
        <Card className="mt-5">
          <CardHeader>
            <CardTitle>Session Ledger</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {me.sessions.map((s) => (
                <li key={s.externalId} className="flex items-center gap-3 py-3 text-sm">
                  <Badge variant="secondary" className="shrink-0">
                    {HARNESS_LABELS[s.harness] ?? s.harness}
                  </Badge>
                  <span className="text-muted-foreground">
                    {s.startedAt ? dateFmt.format(new Date(s.startedAt)) : '—'}
                  </span>
                  <span className="hidden tabular-nums text-muted-foreground sm:inline">
                    {s.messageCount} msgs · {s.toolCallCount} tools
                  </span>
                  <span className="ml-auto flex items-center gap-2 text-xs">
                    {s.verification === 'enclave' ? (
                      <span className="flex items-center gap-1">
                        <SealCheck
                          size={14}
                          weight="duotone"
                          className="text-verify"
                          aria-hidden="true"
                        />
                        <span className="text-verify">enclave</span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">format</span>
                    )}
                    {confirmDelete === s.externalId ? (
                      <span className="flex items-center gap-1">
                        <button
                          className="rounded border border-destructive/50 px-1.5 py-0.5 font-medium text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
                          onClick={async () => {
                            if (await deleteSession(me.passport.id, s.externalId)) onRefresh()
                            setConfirmDelete(null)
                          }}
                        >
                          Remove
                        </button>
                        <button
                          className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foil"
                          onClick={() => setConfirmDelete(null)}
                        >
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button
                        aria-label={`Remove session from ${s.startedAt?.slice(0, 10) ?? 'unknown date'}`}
                        title="Remove this session"
                        className="rounded p-1 text-muted-foreground/60 transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
                        onClick={() => setConfirmDelete(s.externalId)}
                      >
                        <Trash size={14} weight="duotone" aria-hidden="true" />
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Your ladders */}
      <Card className="mt-5">
        <CardHeader>
          <CardTitle>Your Ladders</CardTitle>
          <CardDescription>Private leaderboards you've created or joined.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {me.ladders.length > 0 ? (
            <ul className="divide-y divide-border">
              {me.ladders.map((l) => (
                <li key={l.slug} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                  <a
                    href={`/l/${l.slug}`}
                    className="font-medium text-card-foreground hover:text-foil hover:underline"
                  >
                    {l.name}
                  </a>
                  <span className="text-muted-foreground">
                    {l.rank != null ? `#${l.rank} of ${l.size}` : 'unranked'}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-auto"
                    onClick={() => copyInviteLink(l)}
                  >
                    <Copy size={14} weight="duotone" aria-hidden="true" />
                    {copiedLadderSlug === l.slug ? 'Copied!' : 'Copy invite link'}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">You're not on any ladders yet.</p>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
            <Input
              value={ladderName}
              onChange={(e) => setLadderName(e.target.value)}
              placeholder="Ladder name"
              maxLength={64}
              aria-label="New ladder name"
              className="min-w-0 flex-1"
            />
            <Button onClick={() => void handleCreateLadder()} disabled={ladderBusy || !ladderName.trim()}>
              {ladderBusy ? 'Creating…' : 'Create a ladder'}
            </Button>
          </div>
          {ladderError && <p className="text-xs text-destructive">{ladderError}</p>}
        </CardContent>
      </Card>

      {/* Share */}
      <Card className="mt-5">
        <CardHeader>
          <CardTitle>Share Your Card</CardTitle>
          <CardDescription>Anyone with this link can view your verified AI-use card.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Input
            readOnly
            value={cardUrl}
            aria-label="Public card link"
            onFocus={(e) => e.currentTarget.select()}
            spellCheck={false}
            className="min-w-0 flex-1 font-mono text-xs"
          />
          <Button
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText(cardUrl)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
          >
            <Copy size={15} weight="duotone" aria-hidden="true" /> {copied ? 'Copied!' : 'Copy Link'}
          </Button>
          <Button onClick={() => (location.href = `/p/${me.passport.slug}`)}>
            <ArrowSquareOut size={15} weight="duotone" aria-hidden="true" /> View Card
          </Button>
        </CardContent>
      </Card>

      <div className="mt-10 flex flex-col items-center gap-3">
        <TurnkeyBadge />
        <p className="text-center text-xs text-foreground/60">
          Only aggregate statistics leave the enclave — never your code or prompts.
        </p>
      </div>
    </div>
  )
}

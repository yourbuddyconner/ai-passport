import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, SignOut, UsersThree } from '@phosphor-icons/react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { RankTable } from '@/components/RankTable'
import {
  getLadder,
  joinLadder,
  leaveLadder,
  loadCredentials,
  type LadderView,
  type Me,
} from '@/lib/api'

type JoinState = { status: 'idle' | 'joining' | 'joined'; error: string | null }

export function Ladder({ slug, me }: { slug: string; me: Me | null }) {
  const [data, setData] = useState<LadderView | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [join, setJoin] = useState<JoinState>({ status: 'idle', error: null })
  const [justJoined, setJustJoined] = useState(false)
  const [leaveBusy, setLeaveBusy] = useState(false)

  const joinCode = new URLSearchParams(location.search).get('join')

  // A visitor's own passport can come from a passkey session (me) or a
  // legacy anonymous credential saved in localStorage — mirrors how
  // Passport.tsx/Dashboard.tsx resolve the caller's identity.
  const creds = loadCredentials()
  const mySlug = me?.passport.slug ?? creds?.slug ?? null
  const passportId = me?.passport.id ?? creds?.id ?? null
  const editToken = me ? undefined : creds?.editToken

  const refresh = useCallback(() => {
    getLadder(slug)
      .then((view) => {
        if (!view) setNotFound(true)
        else setData(view)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load ladder'))
  }, [slug])

  useEffect(() => {
    refresh()
  }, [refresh])

  const isMember = !!(data && mySlug && data.entries.some((e) => e.slug === mySlug))
  const membership = isMember || justJoined

  async function handleJoin() {
    if (!passportId || !joinCode) return
    setJoin({ status: 'joining', error: null })
    try {
      await joinLadder(slug, joinCode, passportId, editToken)
      setJustJoined(true)
      setJoin({ status: 'joined', error: null })
      refresh()
      const url = new URL(location.href)
      url.searchParams.delete('join')
      history.replaceState(null, '', url.toString())
    } catch (e) {
      setJoin({ status: 'idle', error: e instanceof Error ? e.message : 'failed to join' })
    }
  }

  async function handleLeave() {
    if (!passportId) return
    setLeaveBusy(true)
    try {
      await leaveLadder(slug, passportId, editToken)
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to leave ladder')
    } finally {
      setLeaveBusy(false)
    }
  }

  if (notFound)
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-muted-foreground">
        <p>This ladder doesn't exist.</p>
        <a href="/leaderboard" className="text-sm text-foil hover:underline">
          Back to the global leaderboard →
        </a>
      </div>
    )

  if (!data)
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        {error ?? 'Opening the ladder…'}
      </div>
    )

  return (
    <div className="mx-auto max-w-2xl px-4 py-14">
      <a
        href="/leaderboard"
        className="mb-10 inline-flex items-center gap-2 text-sm text-foreground/70 transition-colors hover:text-foil"
      >
        <ArrowLeft size={16} aria-hidden="true" /> Back to global leaderboard
      </a>

      <header className="page-rise mb-8 text-center">
        <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.35em] text-foreground/60">
          Private Ladder
        </p>
        <h1 className="foil text-4xl font-semibold tracking-tight">{data.name}</h1>
        <p className="mt-3 flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
          <UsersThree size={16} weight="duotone" aria-hidden="true" />
          {data.total} ranked
          {data.pending > 0 &&
            ` · ${data.pending} more joined, awaiting verified sessions`}
        </p>
      </header>

      {error && (
        <p aria-live="polite" className="mb-6 text-center text-sm text-destructive">
          {error}
        </p>
      )}

      {joinCode && !membership && (
        <Card className="page-rise guilloche mb-6" style={{ animationDelay: '80ms' }}>
          <CardContent className="space-y-3 p-5 text-center">
            {passportId ? (
              <>
                <p className="text-sm text-card-foreground">
                  You've been invited to join <strong>{data.name}</strong>.
                </p>
                <Button onClick={() => void handleJoin()} disabled={join.status === 'joining'}>
                  {join.status === 'joining' ? 'Joining…' : 'Join this ladder'}
                </Button>
                {join.error && <p className="text-sm text-destructive">{join.error}</p>}
              </>
            ) : (
              <>
                <p className="text-sm text-card-foreground">
                  You've been invited to join <strong>{data.name}</strong>. Create a passport first
                  to join.
                </p>
                <a href="/" className="text-sm text-foil underline-offset-2 hover:underline">
                  Get Your Own AI Passport →
                </a>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {justJoined && !isMember && (
        <Card className="page-rise guilloche mb-6" style={{ animationDelay: '80ms' }}>
          <CardContent className="space-y-3 p-5 text-center">
            <p className="text-sm text-card-foreground">
              You've joined <strong>{data.name}</strong>. Your rank will appear once you upload an enclave-verified session.
            </p>
            <a href="/dashboard" className="inline-block">
              <Button>Upload session →</Button>
            </a>
          </CardContent>
        </Card>
      )}

      <Card className="page-rise guilloche" style={{ animationDelay: '140ms' }}>
        <CardContent className="p-4">
          <RankTable entries={data.entries} emptyMessage="No one on this ladder has a verified session yet." />
        </CardContent>
      </Card>

      {membership && (
        <div className="page-rise mt-6 flex justify-center" style={{ animationDelay: '200ms' }}>
          <Button variant="outline" size="sm" onClick={() => void handleLeave()} disabled={leaveBusy}>
            <SignOut size={15} weight="duotone" aria-hidden="true" />
            {leaveBusy ? 'Leaving…' : 'Leave ladder'}
          </Button>
        </div>
      )}
    </div>
  )
}

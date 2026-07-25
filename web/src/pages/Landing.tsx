import { useState } from 'react'
import { SealCheck, Fingerprint, Key } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { TurnkeyBadge } from '@/components/TurnkeyBadge'
import { loginWithPasskey, registerWithPasskey } from '@/lib/auth'

export function Landing({ onAuthed }: { onAuthed: () => void }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState<'register' | 'login' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setBusy('register')
    setError(null)
    try {
      await registerWithPasskey(name.trim())
      onAuthed()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong — try again')
    } finally {
      setBusy(null)
    }
  }

  async function handleLogin() {
    setBusy('login')
    setError(null)
    try {
      await loginWithPasskey()
      onAuthed()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong — try again')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-20">
      {/* The cover */}
      <header className="page-rise mb-14 text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full border-2 border-foil/60">
          <SealCheck size={34} weight="duotone" className="text-foil" aria-hidden="true" />
        </div>
        <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.35em] text-foreground/60">
          Verified AI Use
        </p>
        <h1 className="foil text-5xl font-semibold tracking-tight">AI Passport</h1>
        <p className="mx-auto mt-5 max-w-md text-pretty text-lg text-foreground/80">
          Your coding-agent sessions, analyzed in a secure enclave and stamped into a card any
          employer can verify.
        </p>
      </header>

      <Card className="page-rise guilloche" style={{ animationDelay: '120ms' }}>
        <CardContent className="space-y-5 p-6 pt-6">
          <form onSubmit={handleRegister} className="space-y-3">
            <label htmlFor="landing-name" className="block text-sm font-medium">
              Name on Your Passport
            </label>
            <div className="flex gap-3">
              <Input
                id="landing-name"
                name="name"
                placeholder="e.g. Conner Swann…"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                autoComplete="name"
                spellCheck={false}
              />
              <Button type="submit" disabled={!!busy || !name.trim()}>
                <Fingerprint size={16} weight="bold" aria-hidden="true" />
                {busy === 'register' ? 'Creating…' : 'Create with Passkey'}
              </Button>
            </div>
          </form>

          <div className="flex items-center gap-3" aria-hidden="true">
            <span className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground">returning traveler?</span>
            <span className="h-px flex-1 bg-border" />
          </div>

          <Button variant="outline" className="w-full" onClick={handleLogin} disabled={!!busy}>
            <Key size={16} weight="duotone" aria-hidden="true" />
            {busy === 'login' ? 'Waiting for Your Passkey…' : 'Sign In with Passkey'}
          </Button>

          {error && (
            <p aria-live="polite" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            No password, no email — your device is your identity.
          </p>
        </CardContent>
      </Card>

      <div className="page-rise mt-12 flex flex-col items-center gap-3" style={{ animationDelay: '240ms' }}>
        <TurnkeyBadge />
        <p className="text-center text-xs text-foreground/60">
          Traces are encrypted in your browser and opened only inside a secure enclave — never
          readable by anyone else, including us.{' '}
          <a href="/about" className="text-foil hover:underline">
            How it works →
          </a>
        </p>
        <a href="/leaderboard" className="text-xs text-foreground/60 hover:text-foil hover:underline">
          See the leaderboard →
        </a>
      </div>
    </div>
  )
}

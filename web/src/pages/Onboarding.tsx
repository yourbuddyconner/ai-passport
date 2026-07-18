import { useState } from 'react'
import { Stamp } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { submitOnboarding, type Me } from '@/lib/api'

export function Onboarding({ me, onDone }: { me: Me; onDone: () => void }) {
  const [displayName, setDisplayName] = useState(me.user.displayName)
  const [title, setTitle] = useState(me.user.title ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await submitOnboarding(displayName.trim(), title.trim())
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-4 py-16">
      <Card>
        <CardHeader>
          <div className="mb-2 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Stamp size={20} weight="duotone" aria-hidden="true" />
          </div>
          <CardTitle>Stamp your passport</CardTitle>
          <CardDescription>
            Your passkey is registered. This is what appears on your card — you can change it
            any time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="ob-name" className="text-sm font-medium">
                Name on the card
              </label>
              <Input
                id="ob-name"
                name="name"
                autoComplete="name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={80}
                required
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="ob-title" className="text-sm font-medium">
                Title <span className="text-muted-foreground">(optional)</span>
              </label>
              <Input
                id="ob-title"
                name="organization-title"
                autoComplete="organization-title"
                placeholder="e.g. Staff Engineer, Turnkey…"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={120}
              />
            </div>
            <Button type="submit" className="w-full" disabled={busy || !displayName.trim()}>
              {busy ? 'Stamping…' : 'Open my dashboard'}
            </Button>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

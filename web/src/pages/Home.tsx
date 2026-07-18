import { useCallback, useEffect, useRef, useState } from 'react'
import { Upload, FileJson, CheckCircle2, XCircle, Copy, ExternalLink, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { TurnkeyBadge } from '@/components/TurnkeyBadge'
import {
  createPassport,
  loadCredentials,
  saveCredentials,
  uploadTrace,
  type PassportCredentials,
  type UploadResult,
} from '@/lib/api'

export function Home() {
  const [creds, setCreds] = useState<PassportCredentials | null>(loadCredentials())
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<UploadResult[]>([])
  const [dragging, setDragging] = useState(false)
  const [copied, setCopied] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const cardUrl = creds ? `${location.origin}/p/${creds.slug}` : ''

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      const c = await createPassport(name.trim())
      saveCredentials(c)
      setCreds(c)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      if (!creds) return
      setBusy(true)
      for (const file of Array.from(files)) {
        const result = await uploadTrace(creds, file)
        setResults((prev) => [result, ...prev])
      }
      setBusy(false)
    },
    [creds],
  )

  // Catch drags anywhere on the page: a drop that misses the box should upload,
  // never navigate the browser away.
  useEffect(() => {
    if (!creds) return
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
  }, [creds, handleFiles])

  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <header className="mb-12 text-center">
        <div className="mb-4 inline-flex items-center gap-2 text-primary">
          <ShieldCheck className="h-10 w-10" />
        </div>
        <h1 className="text-4xl font-bold tracking-tight">AI Passport</h1>
        <p className="mt-3 text-lg text-muted-foreground">
          Upload your Claude Code or Codex session traces. Get a verified AI-use card you can
          share with employers.
        </p>
      </header>

      {!creds ? (
        <Card>
          <CardHeader>
            <CardTitle>Create your passport</CardTitle>
            <CardDescription>Pick the name that will appear on your card.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="flex gap-3">
              <Input
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
              />
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy ? 'Creating…' : 'Create'}
              </Button>
            </form>
            {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>{creds.name}'s passport</span>
                <Badge variant="secondary">{creds.slug}</Badge>
              </CardTitle>
              <CardDescription>
                Drop session trace files (.jsonl) below. Claude Code traces live in{' '}
                <code className="text-xs">~/.claude/projects/</code>, Codex traces in{' '}
                <code className="text-xs">~/.codex/sessions/</code>.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div
                className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-10 transition-colors ${
                  dragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
                }`}
                onClick={() => fileInput.current?.click()}
              >
                <Upload className="mb-3 h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  {busy ? 'Uploading…' : 'Drop .jsonl traces anywhere on the page, or click to browse'}
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

              {results.length > 0 && (
                <ul className="space-y-2">
                  {results.map((r, i) => (
                    <li key={i} className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm">
                      {r.ok ? (
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />
                      ) : (
                        <XCircle className="h-4 w-4 shrink-0 text-destructive" />
                      )}
                      <FileJson className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{r.fileName}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {r.ok
                          ? r.duplicate
                            ? 'duplicate — skipped'
                            : `${r.harness} · ${r.messageCount} msgs · ${r.toolCallCount} tool calls${r.verification === 'enclave' ? ' · enclave-verified' : ''}`
                          : r.error}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Share your card</CardTitle>
              <CardDescription>Anyone with this link can view your verified AI-use card.</CardDescription>
            </CardHeader>
            <CardContent className="flex items-center gap-3">
              <Input readOnly value={cardUrl} className="font-mono text-xs" />
              <Button
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(cardUrl)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
              >
                <Copy className="h-4 w-4" /> {copied ? 'Copied!' : 'Copy'}
              </Button>
              <Button onClick={() => (location.href = `/p/${creds.slug}`)}>
                <ExternalLink className="h-4 w-4" /> View
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="mt-10 flex flex-col items-center gap-3">
        <TurnkeyBadge />
        <p className="text-center text-xs text-muted-foreground">
          Traces are analyzed inside a secure enclave; only aggregate statistics are stored —
          never your code or prompts.{' '}
          <a href="/about" className="text-primary hover:underline">
            How it works →
          </a>
        </p>
      </div>
    </div>
  )
}

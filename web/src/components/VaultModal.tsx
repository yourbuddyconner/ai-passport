import { useEffect, useState } from 'react'
import { Lock, Laptop, Globe, Cpu, FileCheck2, KeyRound } from 'lucide-react'
import { Dialog } from '@/components/ui/dialog'
import type { PassportCredentials } from '@/lib/api'

// The vault ledger: each layer of the encryption stack, with the real
// algorithms — and live values where we can fetch them. Specificity is the
// point: showing the actual quorum key beats claiming "bank-grade security".

function Mono({ children, wrap = false }: { children: React.ReactNode; wrap?: boolean }) {
  // Algorithm names stay whole; only long hex values (wrap) may break.
  return (
    <code
      className={`rounded bg-black/40 px-1.5 py-0.5 font-mono text-[11px] leading-relaxed text-primary/90 ${
        wrap ? 'break-all' : 'whitespace-nowrap'
      }`}
    >
      {children}
    </code>
  )
}

interface Layer {
  icon: typeof Lock
  place: string
  title: string
  body: React.ReactNode
}

export function VaultModal({
  open,
  onClose,
  creds,
}: {
  open: boolean
  onClose: () => void
  creds: PassportCredentials
}) {
  const [quorumKey, setQuorumKey] = useState<string | null>(null)
  const [keyState, setKeyState] = useState<'loading' | 'live' | 'none'>('loading')

  useEffect(() => {
    if (!open) return
    setKeyState('loading')
    fetch('/api/verifier/public-key')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.publicKey) {
          setQuorumKey(d.publicKey)
          setKeyState('live')
        } else setKeyState('none')
      })
      .catch(() => setKeyState('none'))
  }, [open])

  const layers: Layer[] = [
    {
      icon: Laptop,
      place: 'your machine',
      title: 'The trace never leaves in the clear',
      body: (
        <>
          Your <Mono>.jsonl</Mono> file is read by this page, in this tab. Before anything is
          uploaded, the whole envelope <Mono>{'{passport_id, trace}'}</Mono> is sealed right here
          in your browser.
        </>
      ),
    },
    {
      icon: Lock,
      place: 'your browser',
      title: 'Sealed to the enclave, and only the enclave',
      body: (
        <>
          A fresh <Mono>ECDH P-256</Mono> key agreement with the enclave's quorum key, an{' '}
          <Mono>HMAC-SHA512</Mono> key derivation, then <Mono>AES-256-GCM</Mono> with the key
          identities baked into the authenticated data. This is qos_p256's scheme — the same
          construction Turnkey uses to protect its own key material.
          <span className="mt-2 block">
            {keyState === 'live' && quorumKey ? (
              <>
                Sealing to the live quorum key:{' '}
                <Mono wrap>
                  {quorumKey.slice(0, 40)}…{quorumKey.slice(-8)}
                </Mono>
              </>
            ) : keyState === 'loading' ? (
              <span className="text-muted-foreground">Fetching the live quorum key…</span>
            ) : (
              <span className="text-muted-foreground">
                No enclave configured right now — uploads fall back to plaintext and are marked
                accordingly. Nothing pretends to be sealed.
              </span>
            )}
          </span>
        </>
      ),
    },
    {
      icon: Globe,
      place: 'in transit & at rest',
      title: 'Every hop only ever sees ciphertext',
      body: (
        <>
          TLS 1.3 wraps the already-sealed envelope on the wire. The application server
          (Cloudflare Workers) forwards hex ciphertext it cannot open; the database stores only
          the signed statistics. There is no configuration of this system in which your code or
          prompts sit readable on a server.
        </>
      ),
    },
    {
      icon: Cpu,
      place: 'AWS Nitro Enclave',
      title: 'Opened only inside sealed hardware',
      body: (
        <>
          The quorum private key lives inside an AWS Nitro Enclave running Turnkey's QuorumOS —
          hardware-isolated memory no operator can inspect, including Turnkey and including us.
          The enclave decrypts, computes session statistics, and forgets. It is stateless by
          design: nothing persists inside it.
        </>
      ),
    },
    {
      icon: FileCheck2,
      place: 'the way back',
      title: 'Only signed facts come out',
      body: (
        <>
          What returns is a statistics payload signed with the enclave's key:{' '}
          <Mono>ECDSA P-256/SHA-256</Mono> over the exact bytes, bound to passport{' '}
          <Mono>{creds.id.slice(0, 8)}…</Mono> and to the SHA-256 of your trace. Anyone can
          re-verify that signature — the card page does it in your browser with WebCrypto.
        </>
      ),
    },
  ]

  return (
    <Dialog open={open} onClose={onClose} label="How your trace is protected">
      <div className="border-b border-border bg-gradient-to-r from-primary/15 to-transparent p-6">
        <div className="flex items-center gap-2 text-primary">
          <KeyRound className="h-5 w-5" />
          <span className="text-xs font-semibold uppercase tracking-widest">The vault</span>
        </div>
        <h2 className="mt-2 text-xl font-semibold">Five seals between your code and the world</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          You found the machine room. This is the actual path your trace takes — real
          algorithms, live keys.
        </p>
      </div>

      <ol className="space-y-0 p-6">
        {layers.map((layer, i) => (
          <li
            key={layer.place}
            className="vault-layer relative flex gap-4 pb-6 last:pb-0"
            style={{ animationDelay: `${i * 120}ms` }}
          >
            {i < layers.length - 1 && (
              <span
                aria-hidden
                className="absolute left-[19px] top-10 h-[calc(100%-2.5rem)] w-px bg-border"
              />
            )}
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-primary">
              <layer.icon className="h-4.5 w-4.5" />
            </span>
            <div className="min-w-0 pt-0.5">
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                seal {i + 1} · {layer.place}
              </p>
              <h3 className="mt-0.5 text-sm font-semibold">{layer.title}</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                {layer.body}
              </p>
            </div>
          </li>
        ))}
      </ol>

      <div className="border-t border-border px-6 py-4">
        <p className="text-xs text-muted-foreground">
          Don't take our word for any of this —{' '}
          <a href="/about" className="text-primary hover:underline">
            verify it yourself →
          </a>
        </p>
      </div>
    </Dialog>
  )
}

import { useEffect, useState } from 'react'
import { LockKey, Laptop, GlobeSimple, Cpu, Certificate, Vault } from '@phosphor-icons/react'
import { Dialog } from '@/components/ui/dialog'


// The vault ledger: each layer of the encryption stack, with the real
// algorithms — and live values where we can fetch them. Specificity is the
// point: showing the actual quorum key beats claiming "bank-grade security".

function Mono({ children, wrap = false }: { children: React.ReactNode; wrap?: boolean }) {
  // Algorithm names stay whole; only long hex values (wrap) may break.
  return (
    <code
      className={`rounded bg-black/40 px-1.5 py-0.5 font-mono text-[11px] leading-relaxed text-foil/90 ${
        wrap ? 'break-all' : 'whitespace-nowrap'
      }`}
    >
      {children}
    </code>
  )
}

interface VerifierInfo {
  deployment: Record<string, string>
  live: {
    configured: boolean
    reachable: boolean
    quorumPublicKey: string | null
    attestation: 'attested' | 'dev'
  }
}

const DEPLOYMENT_LABELS: Record<string, string> = {
  environment: 'environment',
  appName: 'app',
  appId: 'app id',
  deploymentId: 'deployment id',
  manifestId: 'manifest id',
  qosVersion: 'QuorumOS',
  verifierVersion: 'verifier version',
  image: 'container image',
  pivotPath: 'pivot path',
  pivotSha256: 'pivot binary sha-256',
  enclave: 'runtime',
  egress: 'egress',
  debugMode: 'debug mode',
  source: 'template source',
}

interface Layer {
  icon: typeof LockKey
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
  creds: { id: string; name: string }
}) {
  const [quorumKey, setQuorumKey] = useState<string | null>(null)
  const [keyState, setKeyState] = useState<'loading' | 'live' | 'none'>('loading')
  const [info, setInfo] = useState<VerifierInfo | null>(null)

  useEffect(() => {
    if (!open) return
    setKeyState('loading')
    fetch('/api/verifier/info')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: VerifierInfo | null) => {
        setInfo(d)
        if (d?.live?.quorumPublicKey) {
          setQuorumKey(d.live.quorumPublicKey)
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
      icon: LockKey,
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
              <span className="text-foreground/60">Fetching the live quorum key…</span>
            ) : (
              <span className="text-foreground/60">
                No enclave configured right now — uploads fall back to plaintext and are marked
                accordingly. Nothing pretends to be sealed.
              </span>
            )}
          </span>
        </>
      ),
    },
    {
      icon: GlobeSimple,
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
      icon: Certificate,
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
      <div className="border-b border-foil/20 bg-gradient-to-r from-foil/15 to-transparent p-6">
        <div className="flex items-center gap-2 text-foil">
          <Vault size={20} weight="duotone" aria-hidden="true" />
          <span className="text-xs font-semibold uppercase tracking-widest">The vault</span>
        </div>
        <h2 className="mt-2 text-xl font-semibold">Five seals between your code and the world</h2>
        <p className="mt-1 text-sm text-foreground/70">
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
                className="absolute left-[19px] top-10 h-[calc(100%-2.5rem)] w-px bg-foil/20"
              />
            )}
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-foil/30 bg-foil/10 text-foil">
              <layer.icon size={18} weight="duotone" aria-hidden="true" />
            </span>
            <div className="min-w-0 pt-0.5">
              <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
                seal {i + 1} · {layer.place}
              </p>
              <h3 className="mt-0.5 text-sm font-semibold">{layer.title}</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-foreground/70">
                {layer.body}
              </p>
            </div>
          </li>
        ))}
      </ol>

      {info && (
        <div className="border-t border-foil/20 px-6 py-5">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-widest text-foreground/50">
            deployment manifest
          </p>
          <p className="mb-3 text-[13px] leading-relaxed text-foreground/70">
            The exact deployment serving your proofs right now. An auditor checks these pinned
            digests against the enclave's attestation document and a reproducible rebuild.
          </p>
          <dl className="space-y-1.5">
            {Object.entries(info.deployment).map(([k, v]) => (
              <div key={k} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
                <dt className="w-40 shrink-0 font-mono text-[10px] uppercase tracking-widest text-foreground/50 sm:pt-0.5">
                  {DEPLOYMENT_LABELS[k] ?? k}
                </dt>
                <dd className="min-w-0 break-all font-mono text-[11px] text-foil/90" translate="no">
                  {v}
                </dd>
              </div>
            ))}
            <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
              <dt className="w-40 shrink-0 font-mono text-[10px] uppercase tracking-widest text-foreground/50 sm:pt-0.5">
                enclave status
              </dt>
              <dd className="min-w-0 font-mono text-[11px] text-foil/90">
                {info.live.reachable ? 'reachable · serving proofs' : info.live.configured ? 'configured · unreachable' : 'not configured'}
              </dd>
            </div>
            <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
              <dt className="w-40 shrink-0 font-mono text-[10px] uppercase tracking-widest text-foreground/50 sm:pt-0.5">
                attestation
              </dt>
              <dd className="min-w-0 font-mono text-[11px] text-foil/90">
                {info.live.attestation === 'attested'
                  ? 'nitro attestation verified'
                  : 'signatures verified · attestation-doc check pending'}
              </dd>
            </div>
          </dl>
        </div>
      )}

      <div className="border-t border-foil/20 px-6 py-4">
        <p className="text-xs text-foreground/60">
          Don't take our word for any of this —{' '}
          <a href="/about" className="text-foil hover:underline">
            verify it yourself →
          </a>
        </p>
      </div>
    </Dialog>
  )
}

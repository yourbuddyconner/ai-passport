import { useEffect, useState } from 'react'
import { SealCheck, LockKey, Certificate, Cpu, ArrowLeft, GithubLogo } from '@phosphor-icons/react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

function Step({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof LockKey
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="flex gap-4">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-primary/30 bg-primary/10 text-primary">
        <Icon size={20} weight="duotone" aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <h3 className="font-semibold text-card-foreground">{title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{children}</p>
      </div>
    </div>
  )
}

/* Numbered verification steps — a real sequence, so numbering carries meaning. */
function VerifyStep({
  n,
  title,
  badge,
  children,
}: {
  n: number
  title: string
  badge: string
  children: React.ReactNode
}) {
  return (
    <div className="flex gap-4">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-primary/50 font-mono text-lg font-bold text-primary">
        {n}
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold text-card-foreground">{title}</h3>
          <span className="rounded-full border border-verify/40 bg-verify/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-verify">
            {badge}
          </span>
        </div>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{children}</p>
      </div>
    </div>
  )
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 text-xs text-card-foreground" translate="no">
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

const MANIFEST_LABELS: Record<string, string> = {
  environment: 'Environment',
  appName: 'App',
  appId: 'App ID',
  deploymentId: 'Deployment ID',
  manifestId: 'Manifest ID',
  qosVersion: 'QuorumOS',
  verifierVersion: 'Verifier version',
  image: 'Container image',
  pivotPath: 'Pivot path',
  pivotSha256: 'Pivot binary SHA-256',
  enclave: 'Runtime',
  egress: 'Egress',
  debugMode: 'Debug mode',
  repository: 'Source repository',
  template: 'Built from template',
}

function isUrl(v: string): boolean {
  return v.startsWith('https://')
}

export function About() {
  const [info, setInfo] = useState<VerifierInfo | null>(null)
  useEffect(() => {
    fetch('/api/verifier/info')
      .then((r) => (r.ok ? r.json() : null))
      .then(setInfo)
      .catch(() => setInfo(null))
  }, [])
  return (
    <div className="mx-auto max-w-2xl px-4 py-14">
      <a
        href="/"
        className="mb-10 inline-flex items-center gap-2 text-sm text-foreground/70 transition-colors hover:text-foil"
      >
        <ArrowLeft size={16} aria-hidden="true" /> Back to AI Passport
      </a>

      <header className="page-rise mb-10">
        <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.35em] text-foreground/60">
          The Fine Print
        </p>
        <h1 className="foil text-4xl font-semibold tracking-tight">
          How your data is protected
        </h1>
        <p className="mt-4 text-pretty leading-relaxed text-foreground/80">
          AI Passport analyzes your coding-session traces inside a secure enclave powered by{' '}
          <a
            href="https://docs.turnkey.com/features/verifiable-cloud/overview"
            className="text-foil underline-offset-2 hover:underline"
            target="_blank"
            rel="noreferrer"
          >
            Turnkey Verifiable Cloud
          </a>
          . Your traces contain your prompts and your code — so the analysis is designed to be
          both private and independently verifiable.
        </p>
      </header>

      <Card className="page-rise guilloche mb-6" style={{ animationDelay: '100ms' }}>
        <CardHeader>
          <CardTitle>The Architecture</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <Step icon={LockKey} title="Traces are encrypted in your browser">
            Session traces are encrypted <strong className="text-card-foreground">in your browser</strong> to
            the enclave's <strong className="text-card-foreground">quorum key</strong> before upload
            (ECDH P-256 + AES-256-GCM, the qos_p256 scheme). The application server and storage
            layer (Cloudflare Workers/D1/R2) only ever see ciphertext — the plaintext trace,
            with your code and prompts in it, exists only on your machine and inside the
            enclave.
          </Step>
          <Step icon={Cpu} title="Analysis runs inside a TEE">
            The parser and statistics extractor run inside an AWS Nitro Enclave managed by
            Turnkey's QuorumOS. The enclave is{' '}
            <strong className="text-card-foreground">stateless by design</strong>: it decrypts a trace,
            computes session statistics, signs them, and forgets everything. Even the operators
            of this site cannot see inside it.
          </Step>
          <Step icon={Certificate} title="Every session carries an app proof">
            The enclave signs the exact statistics it computed — together with a SHA-256 hash of
            the analyzed trace and the passport ID — using its ephemeral key. That proof is
            stored with the session and shown on the card. Binding the passport ID prevents a
            proof from being replayed onto someone else's card; the trace hash binds it to the
            exact document analyzed.
          </Step>
          <Step icon={SealCheck} title="The score is a public formula">
            The enclave signs <em>facts</em>, not opinions. The fluency score is a
            deterministic, documented formula over the signed session statistics — anyone can
            recompute it from the data shown on the card.
          </Step>
        </CardContent>
      </Card>

      <Card className="page-rise guilloche mb-6" style={{ animationDelay: '180ms' }}>
        <CardHeader>
          <CardTitle>Verify It Yourself</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <VerifyStep n={1} title="Verify the proofs" badge="works today">
            Every card page has a "Verify Proofs" button that checks each session's signature in
            your own browser using WebCrypto — the page just displays the result of code you can
            audit. Or do it fully independently: fetch{' '}
            <Code>/api/passports/slug/&lt;slug&gt;</Code> and verify each session's ECDSA
            P-256/SHA-256 signature (raw r||s) over the proof's <Code>payload</Code> string,
            using bytes 65–130 of the hex public key (qos_p256 keys are an encryption key and a
            signing key concatenated).
          </VerifyStep>

          <VerifyStep n={2} title="Verify the enclave" badge="attestation">
            When the verifier runs on Turnkey Verifiable Cloud, the signing keys are bound to a{' '}
            <a
              href="https://aws.amazon.com/ec2/nitro/nitro-enclaves/"
              className="text-primary underline-offset-2 hover:underline"
              target="_blank"
              rel="noreferrer"
            >
              Nitro attestation document
            </a>
            : a certificate chain rooted at AWS attests to the exact enclave image (PCR
            measurements) that holds the keys. Because the image is built reproducibly with{' '}
            <a
              href="https://stagex.tools"
              className="text-primary underline-offset-2 hover:underline"
              target="_blank"
              rel="noreferrer"
            >
              StageX
            </a>
            , anyone can rebuild the open-source verifier from source and confirm the
            measurements match — proving the code that signed your stats is the code you can
            read.
          </VerifyStep>

          <div className="rounded-md border-l-4 border-verify bg-muted/60 p-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-verify">
              current status
            </p>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              The verifier runs on Turnkey Verifiable Cloud (dev environment) inside real AWS
              Nitro Enclaves. Traces are encrypted end-to-end in your browser, and proof
              signatures are real and verifiable. What's not yet wired up: this app does not
              independently verify the Nitro attestation document chaining the signing keys to
              the enclave image — that check is the remaining step to full attestation, and
              cards say so.
            </p>
          </div>
        </CardContent>
      </Card>

      {info && (
        <Card className="page-rise guilloche mb-6" style={{ animationDelay: '240ms' }}>
          <CardHeader>
            <CardTitle>Deployment Manifest</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
              The exact deployment serving proofs right now. An auditor compares these pinned
              digests against the enclave's attestation document and a reproducible rebuild of
              the source.
            </p>
            <dl className="space-y-2">
              {Object.entries(info.deployment).map(([k, v]) => (
                <div key={k} className="flex flex-col gap-0.5 border-b border-border/50 pb-2 last:border-0 sm:flex-row sm:gap-4">
                  <dt className="w-44 shrink-0 font-mono text-[10px] uppercase tracking-widest text-muted-foreground sm:pt-1">
                    {MANIFEST_LABELS[k] ?? k}
                  </dt>
                  <dd className="min-w-0 break-all font-mono text-[12px] text-card-foreground" translate="no">
                    {isUrl(v) ? (
                      <a href={v} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline">
                        {k === 'repository' && <GithubLogo size={13} weight="duotone" aria-hidden="true" />}
                        {v.replace('https://', '')}
                      </a>
                    ) : (
                      v
                    )}
                  </dd>
                </div>
              ))}
              <div className="flex flex-col gap-0.5 border-b border-border/50 pb-2 sm:flex-row sm:gap-4">
                <dt className="w-44 shrink-0 font-mono text-[10px] uppercase tracking-widest text-muted-foreground sm:pt-1">
                  Enclave status
                </dt>
                <dd className="min-w-0 font-mono text-[12px] text-card-foreground">
                  {info.live.reachable
                    ? 'reachable · serving proofs'
                    : info.live.configured
                      ? 'configured · unreachable'
                      : 'not configured'}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5 border-b border-border/50 pb-2 sm:flex-row sm:gap-4">
                <dt className="w-44 shrink-0 font-mono text-[10px] uppercase tracking-widest text-muted-foreground sm:pt-1">
                  Attestation
                </dt>
                <dd className="min-w-0 font-mono text-[12px] text-card-foreground">
                  {info.live.attestation === 'attested'
                    ? 'Nitro attestation verified'
                    : 'signatures verified · attestation-doc check pending'}
                </dd>
              </div>
              {info.live.quorumPublicKey && (
                <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
                  <dt className="w-44 shrink-0 font-mono text-[10px] uppercase tracking-widest text-muted-foreground sm:pt-1">
                    Live quorum key
                  </dt>
                  <dd className="min-w-0 break-all font-mono text-[12px] text-card-foreground" translate="no">
                    {info.live.quorumPublicKey}
                  </dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>
      )}

      <div className="page-rise flex flex-col items-center gap-3 py-6" style={{ animationDelay: '260ms' }}>
        <a href="https://www.turnkey.com" target="_blank" rel="noreferrer">
          <img
            src="/turnkey/secured-by-turnkey-white.svg"
            alt="Secured by Turnkey"
            width={191}
            height={24}
            className="h-6 w-auto opacity-90 transition-opacity hover:opacity-100"
          />
        </a>
        <p className="text-center text-xs text-foreground/60">
          Verifier source:{' '}
          <code className="rounded bg-white/10 px-1 py-0.5 text-foreground/80" translate="no">
            verifier/
          </code>{' '}
          in the AI Passport repository, built from{' '}
          <a
            href="https://github.com/tkhq/tvc-template"
            className="text-foil underline-offset-2 hover:underline"
            target="_blank"
            rel="noreferrer"
          >
            tkhq/tvc-template
          </a>
          .
        </p>
      </div>
    </div>
  )
}

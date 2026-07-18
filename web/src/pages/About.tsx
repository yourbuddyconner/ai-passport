import { ShieldCheck, Lock, FileCheck2, Cpu, ArrowLeft } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

function Step({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Lock
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="flex gap-4">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <h3 className="font-semibold">{title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{children}</p>
      </div>
    </div>
  )
}

export function About() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <a
        href="/"
        className="mb-8 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back to AI Passport
      </a>

      <header className="mb-10">
        <h1 className="text-3xl font-bold tracking-tight">How your data is protected</h1>
        <p className="mt-3 text-muted-foreground">
          AI Passport analyzes your coding-session traces inside a secure enclave powered by{' '}
          <a
            href="https://docs.turnkey.com/features/verifiable-cloud/overview"
            className="text-primary hover:underline"
            target="_blank"
            rel="noreferrer"
          >
            Turnkey Verifiable Cloud
          </a>
          . Your traces contain your prompts and your code — so the analysis is designed to be
          both private and independently verifiable.
        </p>
      </header>

      <Card className="mb-8">
        <CardHeader>
          <CardTitle>The architecture</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <Step icon={Lock} title="Traces are encrypted to the enclave">
            Session traces are encrypted to the enclave's <strong>quorum key</strong> before
            analysis. The application storage layer (Cloudflare D1/R2) holds only ciphertext and
            aggregate statistics — the plaintext trace, with your code and prompts in it, is
            only ever visible inside the enclave.
          </Step>
          <Step icon={Cpu} title="Analysis runs inside a TEE">
            The parser and statistics extractor run inside an AWS Nitro Enclave managed by
            Turnkey's QuorumOS. The enclave is <strong>stateless by design</strong>: it decrypts
            a trace, computes session statistics, signs them, and forgets everything. Even the
            operators of this site cannot see inside it.
          </Step>
          <Step icon={FileCheck2} title="Every session carries an app proof">
            The enclave signs the exact statistics it computed — together with a SHA-256 hash of
            the analyzed trace and the passport ID — using its ephemeral key. That proof is
            stored with the session and shown on the card. Binding the passport ID prevents a
            proof from being replayed onto someone else's card; the trace hash binds it to the
            exact document analyzed.
          </Step>
          <Step icon={ShieldCheck} title="The score is a public formula">
            The enclave signs <em>facts</em>, not opinions. The fluency score is a deterministic,
            documented formula over the signed session statistics — anyone can recompute it from
            the data shown on the card.
          </Step>
        </CardContent>
      </Card>

      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Verify it yourself</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            <strong className="text-foreground">1. Verify the proofs (works today).</strong>{' '}
            Every card page has a "Verify proofs" button that checks each session's signature in
            your own browser using WebCrypto — the page just displays the result of code you can
            audit. Or do it fully independently: fetch{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              /api/passports/slug/&lt;slug&gt;
            </code>{' '}
            and verify each session's ECDSA P-256/SHA-256 signature (raw r||s) over the proof's{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">payload</code> string, using
            bytes 65–130 of the hex public key (qos_p256 keys are an encryption key and a
            signing key concatenated).
          </p>
          <p>
            <strong className="text-foreground">2. Verify the enclave (production TVC).</strong>{' '}
            When the verifier runs on Turnkey Verifiable Cloud, the signing keys are bound to a{' '}
            <a
              href="https://aws.amazon.com/ec2/nitro/nitro-enclaves/"
              className="text-primary hover:underline"
              target="_blank"
              rel="noreferrer"
            >
              Nitro attestation document
            </a>
            : a certificate chain rooted at AWS attests to the exact enclave image (PCR
            measurements) that holds the keys. Because the image is built reproducibly with{' '}
            <a
              href="https://stagex.tools"
              className="text-primary hover:underline"
              target="_blank"
              rel="noreferrer"
            >
              StageX
            </a>
            , anyone can rebuild the open-source verifier from source and confirm the
            measurements match — proving the code that signed your stats is the code you can
            read.
          </p>
          <p className="rounded-md border border-border bg-muted/50 p-3">
            <strong className="text-foreground">Current status:</strong> this deployment runs the
            verifier in development mode (local enclave app, development keys). Proof signatures
            are real and verifiable; the attestation chain to AWS Nitro lands when the verifier
            moves onto TVC production. Cards indicate which mode produced each proof.
          </p>
        </CardContent>
      </Card>

      <div className="flex flex-col items-center gap-3 py-6">
        <a href="https://www.turnkey.com" target="_blank" rel="noreferrer">
          <img
            src="/turnkey/secured-by-turnkey-white.svg"
            alt="Secured by Turnkey"
            className="h-8 opacity-90 transition-opacity hover:opacity-100"
          />
        </a>
        <p className="text-xs text-muted-foreground">
          Verifier source:{' '}
          <code className="rounded bg-muted px-1 py-0.5">verifier/</code> in the AI Passport
          repository, built from{' '}
          <a
            href="https://github.com/tkhq/tvc-template"
            className="text-primary hover:underline"
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

// Easter egg for the curious: a console banner that invites visitors to verify
// enclave proofs themselves, plus a global `verifyPassport(slug)` helper that
// runs the same WebCrypto check the UI uses (see verify.ts) — no server trust,
// no bundled magic.

import { verifyProofSignature, type AppProof } from './verify'

interface SlugSession {
  externalId: string
  harness: string
  verification: 'enclave' | 'format'
  proof: AppProof | null
}

const REPO = 'https://github.com/yourbuddyconner/ai-passport'

async function verifyPassport(slug?: string): Promise<void> {
  if (!slug) {
    const m = location.pathname.match(/^\/p\/([^/]+)/)
    if (!m) {
      console.log(
        `Pass a passport slug, e.g. verifyPassport('some-slug') — or run this on a /p/<slug> page.`,
      )
      return
    }
    slug = m[1]
  }
  const res = await fetch(`/api/passports/slug/${slug}`)
  if (!res.ok) {
    console.log(`Couldn't fetch passport "${slug}" (HTTP ${res.status}).`)
    return
  }
  const view = (await res.json()) as { sessions: SlugSession[] }
  const rows = []
  for (const s of view.sessions) {
    rows.push({
      session: s.externalId.slice(0, 8),
      harness: s.harness,
      verification: s.verification,
      signature: s.proof ? ((await verifyProofSignature(s.proof)) ? '✓ valid' : '✗ INVALID') : '— none',
    })
  }
  console.table(rows)
  const proofs = view.sessions.filter((s) => s.proof)
  console.log(
    `${proofs.length} proof(s) checked with crypto.subtle.verify (ECDSA P-256 / SHA-256) — ` +
      `right here in your browser, against the enclave's signing key. ` +
      `Read the code that just ran: ${REPO}/blob/master/web/src/lib/consoleEasterEgg.ts ` +
      `and the signature check it calls: ${REPO}/blob/master/web/src/lib/verify.ts`,
  )
}

export function printConsoleEasterEgg(): void {
  const w = window as typeof window & { verifyPassport?: typeof verifyPassport; __aiPassportBanner?: boolean }
  if (w.__aiPassportBanner) return
  w.__aiPassportBanner = true
  w.verifyPassport = verifyPassport

  console.log(
    '%c🛂 AI Passport%c\n\n' +
      "Opening the console, checking our work? Good instinct — that's the whole point of this product.\n\n" +
      'Every "enclave" session card carries a signed proof: an ECDSA P-256 signature from a\n' +
      'Turnkey Verifiable Cloud enclave over the exact stats you see. You don\'t have to trust\n' +
      'us, this page, or even this log message.\n\n' +
      '%cTry it yourself, right now:%c\n' +
      "  await verifyPassport('<slug>')   // any /p/<slug> card, or no args on a card page\n\n" +
      "Don't trust our verifyPassport either? Fair. Read it — it's a fetch plus ~40 lines of WebCrypto:\n" +
      `  ${REPO}/blob/master/web/src/lib/consoleEasterEgg.ts   (verifyPassport itself)\n` +
      `  ${REPO}/blob/master/web/src/lib/verify.ts   (the signature check it calls)\n\n` +
      'And the code that produces the numbers being signed:\n' +
      `  ${REPO}/tree/master/verifier   (the enclave app — Rust, reproducibly built)\n` +
      `  ${REPO}/blob/master/worker/src/verifier.ts   (attestation checks)\n\n` +
      'Kick the tires. Open an issue if anything doesn\'t add up. 🕵️',
    'font-size: 16px; font-weight: bold; padding: 4px 0;',
    'font-size: 12px;',
    'font-size: 12px; font-weight: bold;',
    'font-size: 12px;',
  )
}

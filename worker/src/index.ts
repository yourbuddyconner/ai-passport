import { Hono } from 'hono'
import { parseTrace, ParseError, type SessionStats } from './parsers'
import { aggregate, type SessionRow } from './score'
import {
  analyzeCiphertext,
  analyzeViaEnclave,
  attestationMode,
  fetchQuorumPublicKey,
  VerifierError,
} from './verifier'

type Env = {
  DB: D1Database
  ASSETS: Fetcher
  TRACES?: R2Bucket
  VERIFIER_URL?: string
  VERIFIER_ATTESTED?: string
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

const app = new Hono<{ Bindings: Env }>()

const slugWords = [
  'swift', 'nova', 'quantum', 'cipher', 'vector', 'neural', 'lumen', 'orbit',
  'pixel', 'delta', 'atlas', 'ember', 'flux', 'krypto', 'zenith', 'raven',
]

function makeSlug(): string {
  const pick = () => slugWords[Math.floor(Math.random() * slugWords.length)]
  return `${pick()}-${pick()}-${crypto.randomUUID().slice(0, 6)}`
}

app.post('/api/passports', async (c) => {
  const body = await c.req.json().catch(() => null)
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : ''
  if (!name) return c.json({ error: 'name is required' }, 400)

  const id = crypto.randomUUID()
  const slug = makeSlug()
  const editToken = crypto.randomUUID()
  await c.env.DB.prepare(
    'INSERT INTO passports (id, slug, name, edit_token, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(id, slug, name, editToken, new Date().toISOString())
    .run()
  return c.json({ id, slug, editToken }, 201)
})

// Quorum public key for browser-side envelope encryption. Proxied (and
// cached) so the browser needs no CORS access to the enclave. 404 when no
// verifier is configured — the client then uses the plaintext upload path.
let cachedQuorumKey: { url: string; key: string } | null = null
app.get('/api/verifier/public-key', async (c) => {
  if (!c.env.VERIFIER_URL) return c.json({ error: 'no verifier configured' }, 404)
  try {
    if (cachedQuorumKey?.url !== c.env.VERIFIER_URL) {
      cachedQuorumKey = {
        url: c.env.VERIFIER_URL,
        key: await fetchQuorumPublicKey(c.env.VERIFIER_URL),
      }
    }
    return c.json({ publicKey: cachedQuorumKey.key })
  } catch (e) {
    console.error('quorum key fetch failed:', e)
    return c.json({ error: 'verifier unreachable' }, 502)
  }
})

// Lightweight existence check so clients can validate saved credentials.
app.get('/api/passports/:id', async (c) => {
  const passport = await c.env.DB.prepare('SELECT id, slug, name FROM passports WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ id: string; slug: string; name: string }>()
  if (!passport) return c.json({ error: 'passport not found' }, 404)
  return c.json({ id: passport.id, slug: passport.slug, name: passport.name })
})

app.post('/api/passports/:id/sessions', async (c) => {
  const id = c.req.param('id')
  const token = c.req.header('x-edit-token')
  const passport = await c.env.DB.prepare('SELECT id, edit_token FROM passports WHERE id = ?')
    .bind(id)
    .first<{ id: string; edit_token: string }>()
  if (!passport) return c.json({ error: 'passport not found' }, 404)
  if (!token || token !== passport.edit_token) return c.json({ error: 'invalid edit token' }, 403)

  const len = Number(c.req.header('content-length') ?? 0)
  if (len > MAX_UPLOAD_BYTES * 3) return c.json({ error: 'file too large (max 25 MB)' }, 413)
  const text = await c.req.text()

  let stats: SessionStats | null = null
  let verification: 'enclave' | 'format' = 'format'
  let proof: string | null = null
  let ciphertext: string | null = null

  // End-to-end path: the browser encrypted {passport_id, trace} to the quorum
  // key itself and sends only ciphertext — this Worker never sees plaintext.
  // No fallback is possible (there is nothing to parse locally); errors are
  // surfaced to the client.
  if (c.req.header('content-type')?.includes('application/json')) {
    const body = JSON.parse(text) as { ciphertext?: string }
    if (!body.ciphertext || !/^[0-9a-f]+$/.test(body.ciphertext))
      return c.json({ error: 'ciphertext (hex) is required' }, 400)
    if (!c.env.VERIFIER_URL) return c.json({ error: 'no verifier configured' }, 503)
    try {
      const analysis = await analyzeCiphertext(c.env.VERIFIER_URL, id, body.ciphertext)
      stats = analysis.stats
      verification = 'enclave'
      proof = JSON.stringify(analysis.proof)
      ciphertext = body.ciphertext
    } catch (e) {
      if (e instanceof VerifierError) return c.json({ error: e.message }, e.status as 400)
      throw e
    }
  } else {
    // Plaintext path: prefer the enclave (Worker-side encryption); fall back
    // to in-Worker parsing so the app keeps working when no verifier is
    // configured or reachable.
    if (text.length > MAX_UPLOAD_BYTES) return c.json({ error: 'file too large (max 25 MB)' }, 413)
    if (c.env.VERIFIER_URL) {
      try {
        const result = await analyzeViaEnclave(c.env.VERIFIER_URL, id, text)
        stats = result.analysis.stats
        verification = 'enclave'
        proof = JSON.stringify(result.analysis.proof)
        ciphertext = result.ciphertext
      } catch (e) {
        // 422 = the enclave parsed the trace and rejected it as invalid.
        if (e instanceof VerifierError && e.status === 422)
          return c.json({ error: e.message }, 422)
        console.error('enclave analysis failed, falling back to local parse:', e)
      }
    }
    if (!stats) {
      try {
        stats = parseTrace(text)
      } catch (e) {
        if (e instanceof ParseError) return c.json({ error: e.message }, 422)
        throw e
      }
    }
  }

  const existing = await c.env.DB.prepare(
    'SELECT id FROM sessions WHERE passport_id = ? AND external_id = ?',
  )
    .bind(id, stats.externalId)
    .first()
  if (existing) return c.json({ duplicate: true, session: stats, verification }, 200)

  // Keep the quorum-encrypted trace for future re-verification. Only the
  // enclave can decrypt it; the Worker and R2 never hold plaintext at rest.
  let r2Key: string | null = null
  if (ciphertext && c.env.TRACES) {
    r2Key = `traces/${id}/${stats.externalId}.enc`
    await c.env.TRACES.put(r2Key, ciphertext)
  }

  await c.env.DB.prepare(
    `INSERT INTO sessions
      (id, passport_id, harness, external_id, started_at, ended_at,
       message_count, tool_call_count, input_tokens, output_tokens,
       models, tool_counts, created_at, verification, proof, r2_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      id,
      stats.harness,
      stats.externalId,
      stats.startedAt,
      stats.endedAt,
      stats.messageCount,
      stats.toolCallCount,
      stats.inputTokens,
      stats.outputTokens,
      JSON.stringify(stats.models),
      JSON.stringify(stats.toolCounts),
      new Date().toISOString(),
      verification,
      proof,
      r2Key,
    )
    .run()
  return c.json({ duplicate: false, session: stats, verification }, 201)
})

app.get('/api/passports/slug/:slug', async (c) => {
  const slug = c.req.param('slug')
  const passport = await c.env.DB.prepare(
    'SELECT id, slug, name, created_at FROM passports WHERE slug = ?',
  )
    .bind(slug)
    .first<{ id: string; slug: string; name: string; created_at: string }>()
  if (!passport) return c.json({ error: 'passport not found' }, 404)

  const { results } = await c.env.DB.prepare(
    `SELECT harness, external_id, started_at, ended_at, message_count, tool_call_count,
            input_tokens, output_tokens, models, tool_counts, verification, proof
     FROM sessions WHERE passport_id = ?`,
  )
    .bind(passport.id)
    .all<SessionRow & { external_id: string; verification: string; proof: string | null }>()

  const rows = results ?? []
  return c.json({
    passport: { slug: passport.slug, name: passport.name, createdAt: passport.created_at },
    card: aggregate(rows),
    verification: {
      // 'attested' once the verifier runs on TVC prod with attestation checks;
      // 'dev' while proofs come from a local enclave app with dev keys.
      attestation: attestationMode(c.env),
      enclaveSessions: rows.filter((r) => r.verification === 'enclave').length,
      totalSessions: rows.length,
    },
    // Per-session proofs so anyone can re-verify the signatures client-side.
    sessions: rows.map((r) => ({
      externalId: r.external_id,
      harness: r.harness,
      verification: r.verification,
      proof: r.proof ? (JSON.parse(r.proof) as unknown) : null,
    })),
  })
})

// Everything else falls through to static frontend assets (SPA).
app.all('*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw)
  if (res.status === 404 && !c.req.path.startsWith('/api/')) {
    return c.env.ASSETS.fetch(new Request(new URL('/', c.req.url), c.req.raw))
  }
  return res
})

export default app

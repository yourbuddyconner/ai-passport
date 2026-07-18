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
import { VERIFIER_DEPLOYMENT } from './deployment'
import { renderCardOg } from './og'
import {
  authenticationOptions,
  clearSessionCookie,
  createLoginSession,
  deleteSession,
  registrationOptions,
  sessionCookie,
  userFromCookie,
  verifyAuthentication,
  verifyRegistration,
} from './auth'

type Env = {
  DB: D1Database
  ASSETS: Fetcher
  TRACES?: R2Bucket
  VERIFIER_URL?: string
  VERIFIER_ATTESTED?: string
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/** Match the enclave's project hash: truncated SHA-256 of the cwd. */
async function hashCwd(cwd: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cwd))
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

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

// ---------- Passkey auth ----------

app.post('/api/auth/register/options', async (c) => {
  const body = await c.req.json().catch(() => null)
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : ''
  if (!name) return c.json({ error: 'name is required' }, 400)
  const { options, challengeId } = await registrationOptions(c.env, c.req.url, name)
  return c.json({ options, challengeId })
})

app.post('/api/auth/register/verify', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body?.challengeId || !body?.response || typeof body?.name !== 'string')
    return c.json({ error: 'challengeId, name and response are required' }, 400)
  try {
    const userId = await verifyRegistration(
      c.env,
      c.req.url,
      body.challengeId,
      body.name,
      body.response,
    )
    // Every account gets its passport at birth.
    const passportId = crypto.randomUUID()
    await c.env.DB.prepare(
      'INSERT INTO passports (id, slug, name, edit_token, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(
        passportId,
        makeSlug(),
        body.name.trim().slice(0, 80),
        crypto.randomUUID(),
        new Date().toISOString(),
        userId,
      )
      .run()
    const session = await createLoginSession(c.env, userId)
    c.header('set-cookie', sessionCookie(session))
    return c.json({ ok: true }, 201)
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'registration failed' }, 400)
  }
})

app.post('/api/auth/login/options', async (c) => {
  const { options, challengeId } = await authenticationOptions(c.env, c.req.url)
  return c.json({ options, challengeId })
})

app.post('/api/auth/login/verify', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body?.challengeId || !body?.response)
    return c.json({ error: 'challengeId and response are required' }, 400)
  try {
    const userId = await verifyAuthentication(c.env, c.req.url, body.challengeId, body.response)
    const session = await createLoginSession(c.env, userId)
    c.header('set-cookie', sessionCookie(session))
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'login failed' }, 400)
  }
})

app.post('/api/auth/logout', async (c) => {
  await deleteSession(c.env, c.req.header('cookie'))
  c.header('set-cookie', clearSessionCookie())
  return c.json({ ok: true })
})

// Everything about the signed-in user in one call: profile, passport, card.
app.get('/api/me', async (c) => {
  const user = await userFromCookie(c.env, c.req.header('cookie'))
  if (!user) return c.json({ error: 'not signed in' }, 401)
  const passport = await c.env.DB.prepare(
    'SELECT id, slug, name FROM passports WHERE user_id = ?',
  )
    .bind(user.id)
    .first<{ id: string; slug: string; name: string }>()
  if (!passport) return c.json({ error: 'no passport for user' }, 500)

  const { results } = await c.env.DB.prepare(
    `SELECT harness, external_id, started_at, ended_at, message_count, tool_call_count,
            input_tokens, output_tokens, models, tool_counts, verification, created_at, project_hash
     FROM sessions WHERE passport_id = ? ORDER BY started_at DESC`,
  )
    .bind(passport.id)
    .all<
      SessionRow & {
        external_id: string
        verification: string
        created_at: string
      }
    >()
  const rows = results ?? []
  return c.json({
    user: { displayName: user.displayName, title: user.title, onboarded: user.onboarded },
    passport,
    card: aggregate(rows),
    sessions: rows.map((r) => ({
      externalId: r.external_id,
      harness: r.harness,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      messageCount: r.message_count,
      toolCallCount: r.tool_call_count,
      verification: r.verification,
      models: JSON.parse(r.models || '[]') as string[],
    })),
  })
})

app.post('/api/me/onboarding', async (c) => {
  const user = await userFromCookie(c.env, c.req.header('cookie'))
  if (!user) return c.json({ error: 'not signed in' }, 401)
  const body = await c.req.json().catch(() => null)
  const displayName =
    typeof body?.displayName === 'string' && body.displayName.trim()
      ? body.displayName.trim().slice(0, 80)
      : user.displayName
  const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 120) : null
  await c.env.DB.prepare('UPDATE users SET display_name = ?, title = ?, onboarded = 1 WHERE id = ?')
    .bind(displayName, title, user.id)
    .run()
  await c.env.DB.prepare('UPDATE passports SET name = ? WHERE user_id = ?')
    .bind(displayName, user.id)
    .run()
  return c.json({ ok: true })
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

// Full deployment disclosure: pinned manifest facts + live enclave state.
app.get('/api/verifier/info', async (c) => {
  let quorumPublicKey: string | null = null
  let reachable = false
  if (c.env.VERIFIER_URL) {
    try {
      quorumPublicKey = await fetchQuorumPublicKey(c.env.VERIFIER_URL)
      reachable = true
    } catch {
      // reported below as unreachable
    }
  }
  return c.json({
    deployment: VERIFIER_DEPLOYMENT,
    live: {
      configured: !!c.env.VERIFIER_URL,
      reachable,
      quorumPublicKey,
      attestation: attestationMode(c.env),
    },
  })
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
  const passport = await c.env.DB.prepare(
    'SELECT id, edit_token, user_id FROM passports WHERE id = ?',
  )
    .bind(id)
    .first<{ id: string; edit_token: string; user_id: string | null }>()
  if (!passport) return c.json({ error: 'passport not found' }, 404)
  // Owner via passkey session cookie, or legacy anonymous edit token.
  const user = await userFromCookie(c.env, c.req.header('cookie'))
  const isOwner = !!user && passport.user_id === user.id
  if (!isOwner && (!token || token !== passport.edit_token))
    return c.json({ error: 'not authorized for this passport' }, 403)

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
    let body: { ciphertext?: string }
    try {
      body = JSON.parse(text) as { ciphertext?: string }
    } catch {
      return c.json({ error: 'request body is not valid JSON' }, 400)
    }
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

  const projectHash = stats.projectHash ?? (stats.cwd ? await hashCwd(stats.cwd) : null)
  await c.env.DB.prepare(
    `INSERT INTO sessions
      (id, passport_id, harness, external_id, started_at, ended_at,
       message_count, tool_call_count, input_tokens, output_tokens,
       models, tool_counts, created_at, verification, proof, r2_key, project_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      projectHash,
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
            input_tokens, output_tokens, models, tool_counts, verification, proof, project_hash
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

// ---------- Share previews ----------

// Dynamic OG image: a 1200×630 passport render. /og/default for the landing.
app.get('/og/:slug', async (c) => {
  const slug = c.req.param('slug').replace(/\.png$/, '')
  try {
    if (slug === 'default') return await renderCardOg('AI Passport', null)
    const passport = await c.env.DB.prepare('SELECT id, name FROM passports WHERE slug = ?')
      .bind(slug)
      .first<{ id: string; name: string }>()
    if (!passport) return c.json({ error: 'not found' }, 404)
    const { results } = await c.env.DB.prepare(
      `SELECT harness, started_at, ended_at, message_count, tool_call_count,
              input_tokens, output_tokens, models, tool_counts, project_hash
       FROM sessions WHERE passport_id = ?`,
    )
      .bind(passport.id)
      .all<SessionRow>()
    return await renderCardOg(passport.name, aggregate(results ?? []))
  } catch (e) {
    console.error('og render failed:', e)
    return c.json({ error: 'preview unavailable' }, 500)
  }
})

// Card pages get their meta injected server-side — crawlers don't run JS.
app.get('/p/:slug', async (c) => {
  const slug = c.req.param('slug')
  const assetRes = await c.env.ASSETS.fetch(new Request(new URL('/', c.req.url), c.req.raw))
  const passport = await c.env.DB.prepare('SELECT id, name FROM passports WHERE slug = ?')
    .bind(slug)
    .first<{ id: string; name: string }>()
  if (!passport) return assetRes

  const { results } = await c.env.DB.prepare(
    `SELECT harness, started_at, ended_at, message_count, tool_call_count,
            input_tokens, output_tokens, models, tool_counts, project_hash
     FROM sessions WHERE passport_id = ?`,
  )
    .bind(passport.id)
    .all<SessionRow>()
  const card = aggregate(results ?? [])
  const origin = new URL(c.req.url).origin
  const title = `${passport.name} — ${card.grade} · AI Passport`
  const description = `${card.score}/100 AI fluency · ${card.totalSessions} enclave-verified sessions · ${card.totalToolCalls} tool calls. Verify the signatures yourself.`
  const image = `${origin}/og/${slug}.png`
  const url = `${origin}/p/${slug}`

  const content: Record<string, string> = {
    'og:title': title,
    'og:description': description,
    'og:image': image,
    'og:url': url,
    'twitter:title': title,
    'twitter:description': description,
    'twitter:image': image,
  }
  return new HTMLRewriter()
    .on('title', {
      element(el) {
        el.setInnerContent(title)
      },
    })
    .on('meta', {
      element(el) {
        const key = el.getAttribute('property') ?? el.getAttribute('name')
        if (key && content[key]) el.setAttribute('content', content[key])
        if (key === 'description') el.setAttribute('content', description)
      },
    })
    .transform(assetRes)
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

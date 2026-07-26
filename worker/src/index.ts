import { Hono, type Context } from 'hono'
import { parseTrace, ParseError, type SessionStats } from './parsers'
import { aggregate, type SessionRow } from './score'
import { applyProfilePatch } from './profile'
import {
  computeVerifiedScore,
  includeGlobalRank,
  isLastMember,
  ladderLimitReached,
  makeInviteCode,
  pickSpotlights,
  rankEntries,
  rankIfListed,
  recomputeVerifiedScore,
  validateLadderName,
  type LeaderboardRow,
} from './ranking'
import {
  analyzeCiphertext,
  analyzeCiphertextRaw,
  analyzeViaEnclave,
  attestationMode,
  fetchQuorumPublicKey,
  mergeLocalV2Metrics,
  parseCiphertextEnvelope,
  shouldPreserveV2,
  VerifierError,
} from './verifier'
import { VERIFIER_DEPLOYMENT } from './deployment'
import { MAX_RAW_CIPHERTEXT_BODY_BYTES, rawBodyTooLarge, sessionQuotaExceeded } from './guards'
import { renderCardOg, renderPodiumOg } from './og'
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

// Matches the client's 30 MB base64 ciphertext ceiling (web/src/lib/api.ts).
const MAX_CIPHERTEXT_BODY_BYTES = 30 * 1024 * 1024
// Matches the client's 25 MB plaintext-fallback ceiling (web/src/lib/api.ts).
const MAX_PLAINTEXT_BODY_BYTES = 25 * 1024 * 1024

// Shared by session write/delete routes: a passport is editable by its
// signed-in owner (passkey session cookie) or by anyone holding the
// legacy anonymous edit token. Returns the passport row + ownership flag,
// or the 404/403 Response to return as-is when unauthorized.
async function authorizePassport(
  c: Context<{ Bindings: Env }>,
  passportId: string,
): Promise<
  | { passport: { id: string; edit_token: string; user_id: string | null }; isOwner: boolean }
  | Response
> {
  const passport = await c.env.DB.prepare(
    'SELECT id, edit_token, user_id FROM passports WHERE id = ?',
  )
    .bind(passportId)
    .first<{ id: string; edit_token: string; user_id: string | null }>()
  if (!passport) return c.json({ error: 'passport not found' }, 404)
  // Owner via passkey session cookie, or legacy anonymous edit token.
  const user = await userFromCookie(c.env, c.req.header('cookie'))
  const token = c.req.header('x-edit-token')
  const isOwner = !!user && passport.user_id === user.id
  if (!isOwner && (!token || token !== passport.edit_token))
    return c.json({ error: 'not authorized for this passport' }, 403)
  return { passport, isOwner }
}

// The leaderboard population: listed passports with ≥1 enclave-verified
// session, aggregated straight in SQL (no per-entry JS aggregate() calls).
// The INNER JOIN guarantees the "≥1 verified session" requirement without a
// separate EXISTS clause. Shared by /api/leaderboard and the globalRank /
// listedCount fields on the card + dashboard payloads so they all agree on
// one ranking.
const LEADERBOARD_QUERY = `
  SELECT p.slug AS slug, p.name AS name, p.verified_score AS verifiedScore,
         p.created_at AS createdAt, COUNT(s.id) AS sessions,
         COALESCE(SUM(s.loc_added), 0) AS locAdded,
         COALESCE(SUM(CASE WHEN s.outcome IN ('shipped', 'landed') THEN 1 ELSE 0 END), 0) AS concludedSessions,
         p.linkedin AS linkedin, p.twitter AS twitter, p.company AS company
  FROM passports p
  JOIN sessions s ON s.passport_id = p.id AND s.verification = 'enclave'
  WHERE p.listed = 1
  GROUP BY p.id
  ORDER BY p.verified_score DESC, p.created_at ASC
`

async function loadLeaderboardEntries(db: D1Database) {
  const { results } = await db.prepare(LEADERBOARD_QUERY).all<LeaderboardRow>()
  return rankEntries(results ?? [])
}

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
    'SELECT id, slug, name, listed, verified_score, linkedin, twitter, company FROM passports WHERE user_id = ?',
  )
    .bind(user.id)
    .first<{
      id: string
      slug: string
      name: string
      listed: number
      verified_score: number
      linkedin: string | null
      twitter: string | null
      company: string | null
    }>()
  if (!passport) return c.json({ error: 'no passport for user' }, 500)

  // Dashboard preview has no small-N floor (unlike the public card payload):
  // the owner always gets to see where they'd land.
  const isListed = !!passport.listed
  const leaderboardEntries = await loadLeaderboardEntries(c.env.DB)
  const listedCount = leaderboardEntries.length
  const ownEntry = leaderboardEntries.find((e) => e.slug === passport.slug)

  const { results } = await c.env.DB.prepare(
    `SELECT harness, external_id, started_at, ended_at, message_count, tool_call_count,
            input_tokens, output_tokens, models, tool_counts, verification, created_at, project_hash,
            loc_added, loc_removed, languages, command_counts, human_turns, agenticity, longest_run,
            parallel_batches, delegation_calls, verified_edit_cycles, red_green_cycles, outcome,
            skills, mcp_servers, background_tasks
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

  // Self-heal verified_score lazily: the stored column can go stale (e.g.
  // it predates a fix, or was written by a code path that didn't recompute
  // it). We already have every enclave-verified session row in hand from
  // the query above, so recomputing here costs zero extra queries — only
  // an UPDATE when the value actually drifted.
  let verifiedScore = passport.verified_score
  const freshVerifiedScore = computeVerifiedScore(rows.filter((r) => r.verification === 'enclave'))
  if (freshVerifiedScore !== verifiedScore) {
    await c.env.DB.prepare('UPDATE passports SET verified_score = ? WHERE id = ?')
      .bind(freshVerifiedScore, passport.id)
      .run()
    verifiedScore = freshVerifiedScore
    passport.verified_score = freshVerifiedScore
  }

  // Own ladder memberships — invite_code is fine to return here since this
  // is the owner viewing their own dashboard, not a public payload. At most
  // LADDER_LIMIT_PER_CREATOR (5) ladders can be created by a user, and joined
  // ladders are typically few, so re-running LADDER_MEMBERS_QUERY per ladder
  // is cheap.
  const { results: ownLadders } = await c.env.DB.prepare(
    `SELECT l.slug AS slug, l.name AS name, l.invite_code AS inviteCode
     FROM ladder_members lm JOIN ladders l ON l.id = lm.ladder_id
     WHERE lm.passport_id = ?
     ORDER BY lm.joined_at ASC`,
  )
    .bind(passport.id)
    .all<{ slug: string; name: string; inviteCode: string }>()
  const ladders = await Promise.all(
    (ownLadders ?? []).map(async (l) => {
      const ladderRow = await c.env.DB.prepare('SELECT id FROM ladders WHERE slug = ?')
        .bind(l.slug)
        .first<{ id: string }>()
      let rank: number | null = null
      let size = 0
      if (ladderRow) {
        const { results: memberRows } = await c.env.DB.prepare(LADDER_MEMBERS_QUERY)
          .bind(ladderRow.id)
          .all<LeaderboardRow>()
        const entries = rankEntries(memberRows ?? [])
        size = entries.length
        rank = entries.find((e) => e.slug === passport.slug)?.rank ?? null
      }
      return { slug: l.slug, name: l.name, rank, size, inviteCode: l.inviteCode }
    }),
  )

  return c.json({
    user: { displayName: user.displayName, title: user.title, onboarded: user.onboarded },
    passport,
    listed: isListed,
    listedCount,
    globalRank: isListed ? (ownEntry?.rank ?? null) : null,
    rankIfListed: isListed ? null : rankIfListed(leaderboardEntries, verifiedScore),
    ladders,
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
  const auth = await authorizePassport(c, id)
  if (auth instanceof Response) return auth

  const contentType = c.req.header('content-type') ?? ''
  const isRawBody = contentType.startsWith('application/octet-stream')
  const isJsonBody = contentType.includes('application/json')
  const len = Number(c.req.header('content-length') ?? 0)
  if (isRawBody) {
    // Pre-check when content-length is present so we can fail fast without
    // buffering the body; the authoritative check below is on actual bytes.
    if (rawBodyTooLarge(len)) return c.json({ error: 'ciphertext body too large (max 48 MB)' }, 413)
  } else if (isJsonBody) {
    if (len > MAX_CIPHERTEXT_BODY_BYTES) return c.json({ error: 'ciphertext body too large (max 30 MB)' }, 413)
  } else {
    if (len > MAX_PLAINTEXT_BODY_BYTES) return c.json({ error: 'file too large (max 25 MB)' }, 413)
  }

  // Cheap abuse guard, ahead of any analysis work (local or enclave), on
  // every upload branch.
  const sessionCount = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM sessions WHERE passport_id = ?',
  )
    .bind(id)
    .first<{ count: number }>()
  if (sessionQuotaExceeded(sessionCount?.count ?? 0))
    return c.json({ error: 'session limit reached for this passport (1000)' }, 429)

  let text = ''
  let rawBytes: Uint8Array | null = null
  if (isRawBody) {
    rawBytes = new Uint8Array(await c.req.arrayBuffer())
    // Authoritative check on actual bytes read, regardless of what (or
    // whether) content-length claimed.
    if (rawBodyTooLarge(rawBytes.byteLength))
      return c.json({ error: 'ciphertext body too large (max 48 MB)' }, 413)
  } else {
    text = await c.req.text()
  }

  let stats: SessionStats | null = null
  let verification: 'enclave' | 'format' = 'format'
  let proof: string | null = null
  let ciphertext: string | null = null
  let ciphertextEncoding: 'hex' | 'base64' = 'hex'
  let ciphertextBytes: Uint8Array | null = null
  // True only for an old (pre-v2) enclave response that never got a local
  // v2 merge — signals the UPDATE path to leave existing v2 columns alone
  // rather than overwrite a real stored value with zeros.
  let preserveV2 = false

  // Raw binary path: the browser encrypted a binary envelope
  // (passport id + trace, canonicalized) to the quorum key and posts the
  // ciphertext bytes directly — no JSON, no base64/hex re-encoding. Same
  // "Worker never sees plaintext" guarantee as the JSON ciphertext path, no
  // plaintext fallback is possible here either.
  if (isRawBody) {
    if (!c.env.VERIFIER_URL) return c.json({ error: 'no verifier configured' }, 503)
    try {
      const analysis = await analyzeCiphertextRaw(c.env.VERIFIER_URL, id, rawBytes as Uint8Array)
      stats = analysis.stats
      verification = 'enclave'
      proof = JSON.stringify(analysis.proof)
      ciphertextBytes = rawBytes
      preserveV2 = shouldPreserveV2(analysis, false)
    } catch (e) {
      if (e instanceof VerifierError) return c.json({ error: e.message }, e.status as 400 | 422)
      throw e
    }
  } else if (isJsonBody) {
    let body: { ciphertext?: string; ciphertextB64?: string }
    try {
      body = JSON.parse(text) as { ciphertext?: string; ciphertextB64?: string }
    } catch {
      return c.json({ error: 'request body is not valid JSON' }, 400)
    }
    // release the raw body copy — a 30MB string is a quarter of Worker memory
    text = ''

    // Legacy hex envelope or the (gzip+)base64 envelope from Task 1 — either
    // is carried opaquely to the enclave, never transcoded here (transcoding
    // a large base64 ciphertext to hex in the Worker is what triggered
    // "worker exceeded resource limits" on big Codex traces).
    const envelope = parseCiphertextEnvelope(body)
    if (!envelope) return c.json({ error: 'ciphertext (hex) or ciphertextB64 is required' }, 400)
    if (!c.env.VERIFIER_URL) return c.json({ error: 'no verifier configured' }, 503)
    try {
      const analysis = await analyzeCiphertext(c.env.VERIFIER_URL, id, envelope)
      stats = analysis.stats
      verification = 'enclave'
      proof = JSON.stringify(analysis.proof)
      ciphertext = envelope.value
      ciphertextEncoding = envelope.encoding
      // No local merge is possible on this path (there is no plaintext to
      // parse), so an old enclave's zero-filled v2 fields must not
      // overwrite a previously-stored v2 row.
      preserveV2 = shouldPreserveV2(analysis, false)
    } catch (e) {
      if (e instanceof VerifierError) return c.json({ error: e.message }, e.status as 400)
      throw e
    }
  } else {
    // Plaintext path: prefer the enclave (Worker-side encryption); fall back
    // to in-Worker parsing so the app keeps working when no verifier is
    // configured or reachable.
    if (text.length > MAX_PLAINTEXT_BODY_BYTES) return c.json({ error: 'file too large (max 25 MB)' }, 413)
    if (c.env.VERIFIER_URL) {
      try {
        const result = await analyzeViaEnclave(c.env.VERIFIER_URL, id, text)
        stats = result.analysis.stats
        verification = 'enclave'
        proof = JSON.stringify(result.analysis.proof)
        ciphertext = result.ciphertext
        // Old (pre-v2) enclave builds return stats without the v2 metrics
        // fields; mapRustStats() zero-fills them. Backfill from the local
        // heuristic parser so uploads through an old enclave don't store
        // zeros for loc/language/agenticity/outcome/etc. Never fail the
        // upload over this — the enclave's v1 stats and proof still stand.
        let merged = false
        if (!result.analysis.hasV2Metrics) {
          try {
            stats = mergeLocalV2Metrics(stats, parseTrace(text))
            merged = true
          } catch {
            // keep the zero-filled enclave stats
          }
        }
        preserveV2 = shouldPreserveV2(result.analysis, merged)
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
    .first<{ id: string }>()

  // Keep the quorum-encrypted trace for future re-verification. Only the
  // enclave can decrypt it; the Worker and R2 never hold plaintext at rest.
  let r2Key: string | null = null
  if (c.env.TRACES) {
    if (ciphertextBytes) {
      r2Key = `traces/${id}/${stats.externalId}.enc`
      await c.env.TRACES.put(r2Key, ciphertextBytes, {
        customMetadata: { encoding: 'binary' },
      })
    } else if (ciphertext) {
      r2Key = `traces/${id}/${stats.externalId}.enc`
      await c.env.TRACES.put(r2Key, ciphertext, {
        customMetadata: { encoding: ciphertextEncoding },
      })
    }
  }

  const projectHash = stats.projectHash ?? (stats.cwd ? await hashCwd(stats.cwd) : null)

  // Re-uploading a known session reprocesses it in place: fresh analysis,
  // fresh proof. Lets users backfill newly added facts (e.g. repo hashes).
  if (existing) {
    if (preserveV2) {
      // Old (pre-v2) enclave build with no local merge available: stats
      // carries zero-filled v2 fields. Leave the previously-stored v2
      // columns untouched rather than overwrite real data with zeros.
      await c.env.DB.prepare(
        `UPDATE sessions SET started_at = ?, ended_at = ?, message_count = ?,
           tool_call_count = ?, input_tokens = ?, output_tokens = ?, models = ?,
           tool_counts = ?, verification = ?, proof = ?, r2_key = COALESCE(?, r2_key),
           project_hash = ? WHERE id = ?`,
      )
        .bind(
          stats.startedAt,
          stats.endedAt,
          stats.messageCount,
          stats.toolCallCount,
          stats.inputTokens,
          stats.outputTokens,
          JSON.stringify(stats.models),
          JSON.stringify(stats.toolCounts),
          verification,
          proof,
          r2Key,
          projectHash,
          existing.id,
        )
        .run()
    } else {
      await c.env.DB.prepare(
        `UPDATE sessions SET started_at = ?, ended_at = ?, message_count = ?,
           tool_call_count = ?, input_tokens = ?, output_tokens = ?, models = ?,
           tool_counts = ?, verification = ?, proof = ?, r2_key = COALESCE(?, r2_key),
           project_hash = ?, loc_added = ?, loc_removed = ?, languages = ?, command_counts = ?,
           human_turns = ?, agenticity = ?, longest_run = ?, parallel_batches = ?,
           delegation_calls = ?, verified_edit_cycles = ?, red_green_cycles = ?, outcome = ?,
           skills = ?, mcp_servers = ?, background_tasks = ? WHERE id = ?`,
      )
        .bind(
          stats.startedAt,
          stats.endedAt,
          stats.messageCount,
          stats.toolCallCount,
          stats.inputTokens,
          stats.outputTokens,
          JSON.stringify(stats.models),
          JSON.stringify(stats.toolCounts),
          verification,
          proof,
          r2Key,
          projectHash,
          stats.locAdded,
          stats.locRemoved,
          JSON.stringify(stats.languages),
          JSON.stringify(stats.commandCounts),
          stats.humanTurns,
          stats.agenticity,
          stats.longestRun,
          stats.parallelBatches,
          stats.delegationCalls,
          stats.verifiedEditCycles,
          stats.redGreenCycles,
          stats.outcome,
          JSON.stringify(stats.skills),
          JSON.stringify(stats.mcpServers),
          stats.backgroundTasks,
          existing.id,
        )
        .run()
    }
    try {
      await recomputeVerifiedScore(c.env.DB, id)
    } catch (e) {
      // verified_score is derived state, repairable by the next write — don't
      // fail the upload over a recompute hiccup.
      console.error('verified_score recompute failed:', e)
    }
    return c.json({ duplicate: false, reprocessed: true, session: stats, verification }, 200)
  }
  await c.env.DB.prepare(
    `INSERT INTO sessions
      (id, passport_id, harness, external_id, started_at, ended_at,
       message_count, tool_call_count, input_tokens, output_tokens,
       models, tool_counts, created_at, verification, proof, r2_key, project_hash,
       loc_added, loc_removed, languages, command_counts, human_turns, agenticity,
       longest_run, parallel_batches, delegation_calls, verified_edit_cycles,
       red_green_cycles, outcome, skills, mcp_servers, background_tasks)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      stats.locAdded,
      stats.locRemoved,
      JSON.stringify(stats.languages),
      JSON.stringify(stats.commandCounts),
      stats.humanTurns,
      stats.agenticity,
      stats.longestRun,
      stats.parallelBatches,
      stats.delegationCalls,
      stats.verifiedEditCycles,
      stats.redGreenCycles,
      stats.outcome,
      JSON.stringify(stats.skills),
      JSON.stringify(stats.mcpServers),
      stats.backgroundTasks,
    )
    .run()
  try {
    await recomputeVerifiedScore(c.env.DB, id)
  } catch (e) {
    // verified_score is derived state, repairable by the next write — don't
    // fail the upload over a recompute hiccup.
    console.error('verified_score recompute failed:', e)
  }
  return c.json({ duplicate: false, session: stats, verification }, 201)
})

app.delete('/api/passports/:id/sessions/:externalId', async (c) => {
  const id = c.req.param('id')
  const auth = await authorizePassport(c, id)
  if (auth instanceof Response) return auth

  const row = await c.env.DB.prepare(
    'SELECT id, r2_key FROM sessions WHERE passport_id = ? AND external_id = ?',
  )
    .bind(id, c.req.param('externalId'))
    .first<{ id: string; r2_key: string | null }>()
  if (!row) return c.json({ error: 'session not found' }, 404)
  if (row.r2_key && c.env.TRACES) await c.env.TRACES.delete(row.r2_key)
  await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(row.id).run()
  try {
    await recomputeVerifiedScore(c.env.DB, id)
  } catch (e) {
    console.error('verified_score recompute failed:', e)
  }
  return c.json({ ok: true })
})

// Toggle leaderboard listing. Always recomputes verified_score in either
// direction — this doubles as the backfill path for passports created
// before verified_score existed, since a listing toggle is the first time
// we know we need the number to be right.
app.patch('/api/passports/:id', async (c) => {
  const id = c.req.param('id')
  const auth = await authorizePassport(c, id)
  if (auth instanceof Response) return auth

  const body = await c.req.json().catch(() => null)
  if (body === null || typeof body !== 'object') return c.json({ error: 'invalid body' }, 400)

  const hasListed = 'listed' in body
  if (hasListed && typeof (body as { listed?: unknown }).listed !== 'boolean') {
    return c.json({ error: 'listed must be a boolean' }, 400)
  }

  const patch = applyProfilePatch(body as Record<string, unknown>)
  if (!patch.ok) return c.json({ error: patch.error }, 400)

  const setClauses: string[] = []
  const params: unknown[] = []
  for (const [key, value] of Object.entries(patch.fields)) {
    setClauses.push(`${key} = ?`)
    params.push(value)
  }
  if (hasListed) {
    setClauses.push('listed = ?')
    params.push((body as { listed: boolean }).listed ? 1 : 0)
  }

  if (setClauses.length > 0) {
    await c.env.DB.prepare(`UPDATE passports SET ${setClauses.join(', ')} WHERE id = ?`)
      .bind(...params, id)
      .run()
  }
  const verifiedScore = await recomputeVerifiedScore(c.env.DB, id)
  return c.json({
    listed: hasListed ? (body as { listed: boolean }).listed : undefined,
    verifiedScore,
    ...patch.fields,
  })
})

// Listed passports with ≥1 enclave-verified session, ranked by verified_score.
app.get('/api/leaderboard', async (c) => {
  const entries = await loadLeaderboardEntries(c.env.DB)
  const spotlights = pickSpotlights(entries)
  c.header('Cache-Control', 'public, max-age=60')
  return c.json({
    total: entries.length,
    entries: entries.map((e) => ({
      rank: e.rank,
      slug: e.slug,
      name: e.name,
      grade: e.grade,
      verifiedScore: e.verifiedScore,
      sessions: e.sessions,
      locAdded: e.locAdded,
      concludedSessions: e.concludedSessions,
      linkedin: e.linkedin,
      twitter: e.twitter,
      company: e.company,
    })),
    spotlights,
  })
})

// ---------- Ladders ----------

// Members with ≥1 enclave-verified session, ranked the same way the global
// leaderboard is (see LEADERBOARD_QUERY) — LEFT JOIN so zero-session members
// still surface a row (sessions = 0), which rankEntries then filters out,
// letting the caller derive `pending` from the difference.
const LADDER_MEMBERS_QUERY = `
  SELECT p.slug AS slug, p.name AS name, p.verified_score AS verifiedScore,
         p.created_at AS createdAt, COUNT(s.id) AS sessions,
         COALESCE(SUM(s.loc_added), 0) AS locAdded,
         COALESCE(SUM(CASE WHEN s.outcome IN ('shipped', 'landed') THEN 1 ELSE 0 END), 0) AS concludedSessions,
         p.linkedin AS linkedin, p.twitter AS twitter, p.company AS company
  FROM ladder_members lm
  JOIN passports p ON p.id = lm.passport_id
  LEFT JOIN sessions s ON s.passport_id = p.id AND s.verification = 'enclave'
  WHERE lm.ladder_id = ?
  GROUP BY p.id
  ORDER BY p.verified_score DESC, p.created_at ASC
`

app.post('/api/ladders', async (c) => {
  const body = await c.req.json().catch(() => null)
  const passportId = typeof body?.passportId === 'string' ? body.passportId : ''
  if (!passportId) return c.json({ error: 'passportId is required' }, 400)
  const auth = await authorizePassport(c, passportId)
  if (auth instanceof Response) return auth

  const name = validateLadderName(body?.name)
  if (!name) return c.json({ error: 'name must be 1-64 characters' }, 400)

  const existingCount = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM ladders WHERE created_by = ?',
  )
    .bind(passportId)
    .first<{ count: number }>()
  if (ladderLimitReached(existingCount?.count ?? 0))
    return c.json({ error: 'ladder limit reached (5)' }, 400)

  const id = crypto.randomUUID()
  const slug = makeSlug()
  const inviteCode = makeInviteCode()
  const now = new Date().toISOString()
  await c.env.DB.prepare(
    'INSERT INTO ladders (id, slug, invite_code, name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, slug, inviteCode, name, passportId, now)
    .run()
  await c.env.DB.prepare(
    'INSERT INTO ladder_members (ladder_id, passport_id, joined_at) VALUES (?, ?, ?)',
  )
    .bind(id, passportId, now)
    .run()
  return c.json({ id, slug, inviteCode }, 201)
})

app.post('/api/ladders/:slug/join', async (c) => {
  const body = await c.req.json().catch(() => null)
  const passportId = typeof body?.passportId === 'string' ? body.passportId : ''
  if (!passportId) return c.json({ error: 'passportId is required' }, 400)
  const auth = await authorizePassport(c, passportId)
  if (auth instanceof Response) return auth

  const ladder = await c.env.DB.prepare(
    'SELECT id, invite_code FROM ladders WHERE slug = ?',
  )
    .bind(c.req.param('slug'))
    .first<{ id: string; invite_code: string }>()
  if (!ladder) return c.json({ error: 'ladder not found' }, 404)

  const inviteCode = typeof body?.inviteCode === 'string' ? body.inviteCode : ''
  if (inviteCode !== ladder.invite_code) return c.json({ error: 'invalid invite code' }, 403)

  // INSERT OR IGNORE keeps this idempotent: already-member re-joins 200, no
  // duplicate row (ladder_members has a composite primary key).
  await c.env.DB.prepare(
    'INSERT OR IGNORE INTO ladder_members (ladder_id, passport_id, joined_at) VALUES (?, ?, ?)',
  )
    .bind(ladder.id, passportId, new Date().toISOString())
    .run()
  try {
    await recomputeVerifiedScore(c.env.DB, passportId)
  } catch (e) {
    console.error('verified_score recompute failed:', e)
  }
  return c.json({ joined: true })
})

app.delete('/api/ladders/:slug/membership', async (c) => {
  const body = await c.req.json().catch(() => null)
  const passportId = typeof body?.passportId === 'string' ? body.passportId : ''
  if (!passportId) return c.json({ error: 'passportId is required' }, 400)
  const auth = await authorizePassport(c, passportId)
  if (auth instanceof Response) return auth

  const ladder = await c.env.DB.prepare('SELECT id FROM ladders WHERE slug = ?')
    .bind(c.req.param('slug'))
    .first<{ id: string }>()
  if (!ladder) return c.json({ error: 'ladder not found' }, 404)

  const membership = await c.env.DB.prepare(
    'SELECT 1 FROM ladder_members WHERE ladder_id = ? AND passport_id = ?',
  )
    .bind(ladder.id, passportId)
    .first()
  if (!membership) return c.json({ error: 'not a member of this ladder' }, 404)

  const memberCount = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM ladder_members WHERE ladder_id = ?',
  )
    .bind(ladder.id)
    .first<{ count: number }>()

  await c.env.DB.prepare(
    'DELETE FROM ladder_members WHERE ladder_id = ? AND passport_id = ?',
  )
    .bind(ladder.id, passportId)
    .run()

  if (isLastMember(memberCount?.count ?? 0)) {
    await c.env.DB.prepare('DELETE FROM ladders WHERE id = ?').bind(ladder.id).run()
  }
  return c.json({ left: true })
})

app.get('/api/ladders/:slug', async (c) => {
  const ladder = await c.env.DB.prepare('SELECT id, name FROM ladders WHERE slug = ?')
    .bind(c.req.param('slug'))
    .first<{ id: string; name: string }>()
  if (!ladder) return c.json({ error: 'ladder not found' }, 404)

  const [{ results }, memberCount] = await Promise.all([
    c.env.DB.prepare(LADDER_MEMBERS_QUERY).bind(ladder.id).all<LeaderboardRow>(),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM ladder_members WHERE ladder_id = ?')
      .bind(ladder.id)
      .first<{ count: number }>(),
  ])
  const entries = rankEntries(results ?? [])
  const totalMembers = memberCount?.count ?? 0
  const pending = totalMembers - entries.length

  return c.json({
    name: ladder.name,
    total: entries.length,
    pending,
    entries: entries.map((e) => ({
      rank: e.rank,
      slug: e.slug,
      name: e.name,
      grade: e.grade,
      verifiedScore: e.verifiedScore,
      sessions: e.sessions,
      locAdded: e.locAdded,
      concludedSessions: e.concludedSessions,
      linkedin: e.linkedin,
      twitter: e.twitter,
      company: e.company,
    })),
  })
})

app.get('/api/passports/slug/:slug', async (c) => {
  const slug = c.req.param('slug')
  const passport = await c.env.DB.prepare(
    'SELECT id, slug, name, created_at, listed, linkedin, twitter, company FROM passports WHERE slug = ?',
  )
    .bind(slug)
    .first<{
      id: string
      slug: string
      name: string
      created_at: string
      listed: number
      linkedin: string | null
      twitter: string | null
      company: string | null
    }>()
  if (!passport) return c.json({ error: 'passport not found' }, 404)

  const { results } = await c.env.DB.prepare(
    `SELECT harness, external_id, started_at, ended_at, message_count, tool_call_count,
            input_tokens, output_tokens, models, tool_counts, verification, proof, project_hash,
            loc_added, loc_removed, languages, command_counts, human_turns, agenticity,
            longest_run, parallel_batches, delegation_calls, verified_edit_cycles,
            red_green_cycles, outcome, skills, mcp_servers, background_tasks
     FROM sessions WHERE passport_id = ?`,
  )
    .bind(passport.id)
    .all<SessionRow & { external_id: string; verification: string; proof: string | null }>()

  const rows = results ?? []

  // Public floor: only surface globalRank/listedCount once the leaderboard
  // is big enough that a single rank isn't a de-facto exact-score reveal.
  let rankFields: { globalRank: number; listedCount: number } | Record<string, never> = {}
  if (passport.listed) {
    const entries = await loadLeaderboardEntries(c.env.DB)
    const listedCount = entries.length
    const entry = entries.find((e) => e.slug === passport.slug)
    if (entry && includeGlobalRank(listedCount)) {
      rankFields = { globalRank: entry.rank, listedCount }
    }
  }

  return c.json({
    passport: {
      slug: passport.slug,
      name: passport.name,
      createdAt: passport.created_at,
      linkedin: passport.linkedin,
      twitter: passport.twitter,
      company: passport.company,
    },
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
    ...rankFields,
  })
})

// ---------- Share previews ----------

// Podium OG image for the global leaderboard's top 3.
app.get('/og/leaderboard', async (c) => {
  try {
    const entries = await loadLeaderboardEntries(c.env.DB)
    const top3 = entries.slice(0, 3).map((e) => ({ name: e.name, grade: e.grade, score: e.verifiedScore }))
    return await renderPodiumOg('Leaderboard', top3)
  } catch (e) {
    console.error('og render failed:', e)
    return c.json({ error: 'preview unavailable' }, 500)
  }
})

// Podium OG image for a ladder's top 3. 404s for an unknown slug, mirroring
// the JSON endpoint (/api/ladders/:slug).
app.get('/og/ladder/:slug', async (c) => {
  try {
    const ladder = await c.env.DB.prepare('SELECT id, name FROM ladders WHERE slug = ?')
      .bind(c.req.param('slug'))
      .first<{ id: string; name: string }>()
    if (!ladder) return c.json({ error: 'ladder not found' }, 404)
    const { results } = await c.env.DB.prepare(LADDER_MEMBERS_QUERY).bind(ladder.id).all<LeaderboardRow>()
    const entries = rankEntries(results ?? [])
    const top3 = entries.slice(0, 3).map((e) => ({ name: e.name, grade: e.grade, score: e.verifiedScore }))
    return await renderPodiumOg(ladder.name, top3)
  } catch (e) {
    console.error('og render failed:', e)
    return c.json({ error: 'preview unavailable' }, 500)
  }
})

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
              input_tokens, output_tokens, models, tool_counts, project_hash,
              loc_added, loc_removed, languages, command_counts, human_turns, agenticity,
              longest_run, parallel_batches, delegation_calls, verified_edit_cycles,
              red_green_cycles, outcome, skills, mcp_servers, background_tasks
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

// Shared server-side meta injection for share-preview pages (card, leaderboard,
// ladder): crawlers don't run JS, so the SPA's client-side title/meta updates
// never reach them — this rewrites the static shell's <title>/<meta> in place.
function rewritePageMeta(
  assetRes: Response,
  { title, description, image, url }: { title: string; description: string; image: string; url: string },
): Response {
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
}

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
            input_tokens, output_tokens, models, tool_counts, project_hash,
            loc_added, loc_removed, languages, command_counts, human_turns, agenticity,
            longest_run, parallel_batches, delegation_calls, verified_edit_cycles,
            red_green_cycles, outcome, skills, mcp_servers, background_tasks
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

  return rewritePageMeta(assetRes, { title, description, image, url })
})

// Leaderboard/ladder pages get their meta injected server-side too, same
// mechanism as /p/:slug — crawlers don't run JS so the SPA's client-side
// title/meta updates never reach them.
app.get('/leaderboard', async (c) => {
  const assetRes = await c.env.ASSETS.fetch(new Request(new URL('/', c.req.url), c.req.raw))
  const origin = new URL(c.req.url).origin
  const title = 'Leaderboard — AI Passport'
  const description = 'Verified AI fluency, ranked. Enclave-attested sessions only — no self-reported scores.'
  const image = `${origin}/og/leaderboard`
  const url = `${origin}/leaderboard`
  return rewritePageMeta(assetRes, { title, description, image, url })
})

app.get('/l/:slug', async (c) => {
  const slug = c.req.param('slug')
  const assetRes = await c.env.ASSETS.fetch(new Request(new URL('/', c.req.url), c.req.raw))
  const ladder = await c.env.DB.prepare('SELECT name FROM ladders WHERE slug = ?')
    .bind(slug)
    .first<{ name: string }>()
  if (!ladder) return assetRes

  const origin = new URL(c.req.url).origin
  const title = `${ladder.name} — AI Passport Ladder`
  const description = `${ladder.name}: a private leaderboard of verified AI fluency. Enclave-attested sessions only.`
  const image = `${origin}/og/ladder/${slug}`
  const url = `${origin}/l/${slug}`
  return rewritePageMeta(assetRes, { title, description, image, url })
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

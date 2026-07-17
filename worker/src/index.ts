import { Hono } from 'hono'
import { parseTrace, ParseError, type SessionStats } from './parsers'
import { aggregate, type SessionRow } from './score'

type Env = {
  DB: D1Database
  ASSETS: Fetcher
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

app.post('/api/passports/:id/sessions', async (c) => {
  const id = c.req.param('id')
  const token = c.req.header('x-edit-token')
  const passport = await c.env.DB.prepare('SELECT id, edit_token FROM passports WHERE id = ?')
    .bind(id)
    .first<{ id: string; edit_token: string }>()
  if (!passport) return c.json({ error: 'passport not found' }, 404)
  if (!token || token !== passport.edit_token) return c.json({ error: 'invalid edit token' }, 403)

  const len = Number(c.req.header('content-length') ?? 0)
  if (len > MAX_UPLOAD_BYTES) return c.json({ error: 'file too large (max 25 MB)' }, 413)
  const text = await c.req.text()
  if (text.length > MAX_UPLOAD_BYTES) return c.json({ error: 'file too large (max 25 MB)' }, 413)

  let stats: SessionStats
  try {
    stats = parseTrace(text)
  } catch (e) {
    if (e instanceof ParseError) return c.json({ error: e.message }, 422)
    throw e
  }

  const existing = await c.env.DB.prepare(
    'SELECT id FROM sessions WHERE passport_id = ? AND external_id = ?',
  )
    .bind(id, stats.externalId)
    .first()
  if (existing) return c.json({ duplicate: true, session: stats }, 200)

  await c.env.DB.prepare(
    `INSERT INTO sessions
      (id, passport_id, harness, external_id, started_at, ended_at,
       message_count, tool_call_count, input_tokens, output_tokens,
       models, tool_counts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    )
    .run()
  return c.json({ duplicate: false, session: stats }, 201)
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
    `SELECT harness, started_at, ended_at, message_count, tool_call_count,
            input_tokens, output_tokens, models, tool_counts
     FROM sessions WHERE passport_id = ?`,
  )
    .bind(passport.id)
    .all<SessionRow>()

  return c.json({
    passport: { slug: passport.slug, name: passport.name, createdAt: passport.created_at },
    card: aggregate(results ?? []),
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

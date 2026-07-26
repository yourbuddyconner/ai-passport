// Profile handles are stored normalized — never as URLs. Links are
// constructed from known prefixes at render time, so user input can never
// become an arbitrary href.

const LINKEDIN_RE = /^[A-Za-z0-9\-]{3,100}$/
const TWITTER_RE = /^[A-Za-z0-9_]{1,15}$/

function stripPrefixes(input: string, hosts: string[], pathPrefix: string): string {
  let s = input.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '')
  for (const h of hosts) if (s.toLowerCase().startsWith(h + '/')) s = s.slice(h.length + 1)
  if (pathPrefix && s.toLowerCase().startsWith(pathPrefix + '/')) s = s.slice(pathPrefix.length + 1)
  return s.replace(/\/+$/, '')
}

export function normalizeLinkedin(input: string): string | null {
  const s = stripPrefixes(input, ['linkedin.com'], 'in')
  return LINKEDIN_RE.test(s) ? s : null
}

export function normalizeTwitter(input: string): string | null {
  const s = stripPrefixes(input, ['x.com', 'twitter.com'], '').replace(/^@/, '')
  return TWITTER_RE.test(s) ? s : null
}

export function normalizeCompany(input: string): string | null {
  const s = input.trim()
  return s.length >= 1 && s.length <= 64 ? s : null
}

type ProfileFields = { linkedin?: string | null; twitter?: string | null; company?: string | null }

export function applyProfilePatch(body: Record<string, unknown>):
  | { ok: true; fields: ProfileFields }
  | { ok: false; error: string } {
  const fields: ProfileFields = {}
  const specs: Array<[keyof ProfileFields, (s: string) => string | null]> = [
    ['linkedin', normalizeLinkedin],
    ['twitter', normalizeTwitter],
    ['company', normalizeCompany],
  ]
  for (const [key, normalize] of specs) {
    if (!(key in body)) continue
    const raw = body[key]
    if (raw === null || raw === '' || (typeof raw === 'string' && raw.trim() === '')) {
      fields[key] = null
      continue
    }
    if (typeof raw !== 'string') return { ok: false, error: `invalid ${key}` }
    const norm = normalize(raw)
    if (norm === null) return { ok: false, error: `invalid ${key}` }
    fields[key] = norm
  }
  return { ok: true, fields }
}

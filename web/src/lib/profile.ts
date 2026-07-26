// Mirrors worker/src/profile.ts (authoritative source of truth). Keep this
// file's normalization logic byte-for-byte identical to the worker's — it
// exists only to give the dashboard instant, client-side validation feedback
// before the real PATCH request hits the server, which re-validates anyway.

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

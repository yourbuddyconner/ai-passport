# Profile Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optional LinkedIn/Twitter/company fields on passports — normalized handles (never URLs), editable from the dashboard, shown on the public card and leaderboard/ladder rows.

**Architecture:** One shared normalization module in the worker (authoritative) mirrored client-side; existing PATCH endpoint extended; payload additions thread through card/me/leaderboard/ladder queries; links constructed from known prefixes only.

**Tech Stack:** Hono + D1, React, vitest.

**Spec:** `docs/superpowers/specs/2026-07-25-profile-fields-design.md` (binding for normalization rules and display).

## Global Constraints

- Stored values are normalized handles; hrefs are only ever `https://www.linkedin.com/in/{slug}` / `https://x.com/{handle}` built at render time.
- Validation charsets exactly: linkedin `^[A-Za-z0-9\-]{3,100}$`, twitter `^[A-Za-z0-9_]{1,15}$`, company trimmed 1-64 chars; null/'' clears.
- Fields NEVER appear in OG images.
- Migration before worker deploy (README ordering rule).
- Per task: `cd worker && npx vitest run && npx tsc --noEmit` clean; web `npm run build` clean. Explicit-path commits only (NEVER `git add -A`).

---

### Task 1: Worker — migration, normalization, PATCH, payloads

**Files:**
- Create: `worker/migrations/0007_profile.sql`
- Modify: `worker/schema.sql`
- Create: `worker/src/profile.ts`
- Modify: `worker/src/index.ts` (PATCH handler; card/me payloads; leaderboard+ladder entry queries in ranking.ts if entry shape lives there — read both)
- Modify: `worker/src/ranking.ts` (entry SELECTs gain p.linkedin, p.twitter, p.company; entry type + shaping)
- Test: `worker/test/profile.test.ts`

**Interfaces:**
- Produces: `normalizeLinkedin(input: string): string | null` (null = invalid), `normalizeTwitter(input: string): string | null`, `normalizeCompany(input: string): string | null` (null = invalid; note: empty-after-trim is CLEAR, handled by the caller distinguishing '' from invalid), and `applyProfilePatch(body): {ok: true, fields: {linkedin?: string|null, twitter?: string|null, company?: string|null}} | {ok: false, error: string}` — only fields present in the body appear in `fields`.

- [ ] **Step 1: Migration + schema**

```sql
-- worker/migrations/0007_profile.sql
ALTER TABLE passports ADD COLUMN linkedin TEXT;
ALTER TABLE passports ADD COLUMN twitter TEXT;
ALTER TABLE passports ADD COLUMN company TEXT;
```
Mirror in schema.sql's passports CREATE TABLE.

- [ ] **Step 2: Failing tests (table-driven)**

```ts
// worker/test/profile.test.ts
import { describe, expect, it } from 'vitest'
import { normalizeLinkedin, normalizeTwitter, normalizeCompany, applyProfilePatch } from '../src/profile'

describe('normalizeLinkedin', () => {
  const ok: Array<[string, string]> = [
    ['https://www.linkedin.com/in/conner-swann/', 'conner-swann'],
    ['linkedin.com/in/conner-swann', 'conner-swann'],
    ['conner-swann', 'conner-swann'],
    ['http://linkedin.com/in/Abc-123', 'Abc-123'],
  ]
  for (const [input, want] of ok) it(`${input} → ${want}`, () => expect(normalizeLinkedin(input)).toBe(want))
  for (const bad of ['ab', 'has space', 'a'.repeat(101), 'slug/extra', 'javascript:alert(1)'])
    it(`rejects ${bad.slice(0, 20)}`, () => expect(normalizeLinkedin(bad)).toBeNull())
})

describe('normalizeTwitter', () => {
  const ok: Array<[string, string]> = [
    ['@yourbuddyconner', 'yourbuddyconner'],
    ['https://x.com/yourbuddyconner', 'yourbuddyconner'],
    ['twitter.com/Under_Score', 'Under_Score'],
    ['plain_handle', 'plain_handle'],
  ]
  for (const [input, want] of ok) it(`${input} → ${want}`, () => expect(normalizeTwitter(input)).toBe(want))
  for (const bad of ['toolonghandle1234', 'has-dash', 'has space', ''])
    it(`rejects '${bad}'`, () => expect(normalizeTwitter(bad)).toBeNull())
})

describe('normalizeCompany', () => {
  it('trims and passes', () => expect(normalizeCompany('  Acme Corp ')).toBe('Acme Corp'))
  it('rejects >64', () => expect(normalizeCompany('x'.repeat(65))).toBeNull())
})

describe('applyProfilePatch', () => {
  it('normalizes present fields, clears on empty, omits absent', () => {
    const r = applyProfilePatch({ linkedin: 'linkedin.com/in/abc-def', company: '' })
    expect(r).toEqual({ ok: true, fields: { linkedin: 'abc-def', company: null } })
  })
  it('400s invalid with field name', () => {
    const r = applyProfilePatch({ twitter: 'way-too-long-and-dashed' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('twitter')
  })
})
```

- [ ] **Step 3: Implement profile.ts**

```ts
// worker/src/profile.ts
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
```

- [ ] **Step 4: Wire PATCH** — in the existing PATCH /api/passports/:id handler: run applyProfilePatch on the body; 400 on error; UPDATE only the present fields (build SET clause from the keys, bound params); keep the listed handling intact. Payloads: add `linkedin, twitter, company` to the passport SELECTs feeding /api/me and slug card payloads, and to the leaderboard/ladder entry queries + entry type in ranking.ts.

- [ ] **Step 5: Migration local, full suite, commit** — `npx wrangler d1 execute ai-passport --local --file=migrations/0007_profile.sql` (nvm use 23) && vitest && tsc. Commit: `feat(worker): profile fields — normalized handles in PATCH and payloads`

---

### Task 2: Web — dashboard editor + display

**Files:**
- Modify: `web/src/lib/api.ts` (types: Me.passport + card + entries gain linkedin/twitter/company; `updateProfile(passportId, fields, auth)` calling PATCH; client-side mirrors of the two normalizers for instant validation feedback — copy the regex/strip logic into a small `web/src/lib/profile.ts`)
- Create: `web/src/lib/profile.ts`
- Modify: `web/src/pages/Dashboard.tsx` (Profile card: three inputs with placeholder examples, Save button, verbatim server errors, saved flash)
- Modify: `web/src/pages/Passport.tsx` (company muted under name; LinkedIn/X icon links — use phosphor icons already in deps (LinkedinLogo, XLogo); hrefs constructed `https://www.linkedin.com/in/${linkedin}` / `https://x.com/${twitter}`, target _blank rel noopener noreferrer)
- Modify: `web/src/components/RankTable.tsx` (company + icons per row when present)

- [ ] Implement; `npm run build` clean; commit: `feat(web): profile editor and card/ladder display`

---

### Task 3: Ship

- [ ] Sweep (worker vitest+tsc, web build) + focused review (one reviewer: normalization bypass attempts — unicode lookalikes/half-stripped URLs stored? href construction sites — any place rendering raw input as a link? payload additions leak nothing else?).
- [ ] Fix round if needed; merge to master.
- [ ] Deploy: `wrangler d1 execute ai-passport --remote --file=migrations/0007_profile.sql` FIRST, then web build + `wrangler deploy`.
- [ ] Probe: PATCH a probe passport with a full LinkedIn URL + @handle, GET card payload → normalized handles present; invalid input → 400 naming the field; cleanup.

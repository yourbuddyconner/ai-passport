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

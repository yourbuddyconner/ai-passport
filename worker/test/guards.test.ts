import { describe, it, expect } from 'vitest'
import { sessionQuotaExceeded, rawBodyTooLarge } from '../src/guards'

describe('sessionQuotaExceeded', () => {
  it('is false below the limit', () => {
    expect(sessionQuotaExceeded(0)).toBe(false)
    expect(sessionQuotaExceeded(999)).toBe(false)
  })

  it('is true at and above the limit (default 1000)', () => {
    expect(sessionQuotaExceeded(1000)).toBe(true)
    expect(sessionQuotaExceeded(1001)).toBe(true)
  })

  it('honors an explicit limit override', () => {
    expect(sessionQuotaExceeded(5, 5)).toBe(true)
    expect(sessionQuotaExceeded(4, 5)).toBe(false)
  })
})

describe('rawBodyTooLarge (413 guard on the raw octet-stream branch)', () => {
  // The route itself isn't unit-testable without a D1/Hono request harness
  // (no existing app-level test scaffold in this worker), so this exercises
  // the exact counted-byte guard the route applies to the actually-read
  // bytes (`rawBodyTooLarge(rawBytes.byteLength)` in index.ts), both at the
  // default 48 MB ceiling and with an explicit limit for a fast/small case.
  it('accepts a byte length at or under the ceiling', () => {
    expect(rawBodyTooLarge(48 * 1024 * 1024)).toBe(false)
    expect(rawBodyTooLarge(10, 10)).toBe(false)
  })

  it('rejects a byte length over the ceiling — the oversized-body 413 path', () => {
    expect(rawBodyTooLarge(48 * 1024 * 1024 + 1)).toBe(true)
    expect(rawBodyTooLarge(11, 10)).toBe(true)
  })
})

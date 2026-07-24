import { describe, it, expect } from 'vitest'
import { bytesToHex } from '../src/qosCrypto'

// The pre-F2 implementation, kept here only as an oracle to check the
// chunked LUT rewrite produces byte-identical output.
function bytesToHexOld(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256)
  return out
}

describe('bytesToHex', () => {
  it('matches the naive implementation on an empty array', () => {
    const bytes = new Uint8Array(0)
    expect(bytesToHex(bytes)).toBe(bytesToHexOld(bytes))
  })

  it('matches the naive implementation on small sizes', () => {
    for (const n of [1, 2, 3, 15, 16, 17, 255, 256, 257]) {
      const bytes = randomBytes(n)
      expect(bytesToHex(bytes)).toBe(bytesToHexOld(bytes))
    }
  })

  it('matches the naive implementation across the 64 KB chunk boundary', () => {
    const chunk = 64 * 1024
    for (const n of [chunk - 1, chunk, chunk + 1, chunk * 2 - 1, chunk * 2, chunk * 2 + 1]) {
      const bytes = randomBytes(n)
      expect(bytesToHex(bytes)).toBe(bytesToHexOld(bytes))
    }
  })

  it('matches the naive implementation on an odd, non-chunk-aligned length', () => {
    // 64 KB chunks * 3 + an odd remainder, deliberately not a multiple of
    // the chunk size or of any obvious power of two.
    const n = 64 * 1024 * 3 + 12345
    const bytes = randomBytes(n)
    expect(bytesToHex(bytes)).toBe(bytesToHexOld(bytes))
  })

  it('handles the full byte value range correctly', () => {
    const bytes = new Uint8Array(256)
    for (let i = 0; i < 256; i++) bytes[i] = i
    const hex = bytesToHex(bytes)
    expect(hex).toBe(bytesToHexOld(bytes))
    expect(hex.slice(0, 2)).toBe('00')
    expect(hex.slice(-2)).toBe('ff')
  })

  it('completes quickly on a 5 MB input', () => {
    const bytes = randomBytes(5 * 1024 * 1024)
    const start = performance.now()
    const hex = bytesToHex(bytes)
    const elapsed = performance.now() - start
    expect(hex.length).toBe(bytes.length * 2)
    expect(elapsed).toBeLessThan(2000)
  })
})

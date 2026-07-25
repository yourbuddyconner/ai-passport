// Small, dependency-free upload guards for the sessions POST route, split
// out of index.ts so they're unit-testable without pulling in the rest of
// the app (index.ts transitively imports workers-og, whose wasm asset
// vitest's node environment can't load outside a wrangler runtime).

// Matches the client's 48 MB raw binary ciphertext ceiling (web/src/lib/api.ts).
export const MAX_RAW_CIPHERTEXT_BODY_BYTES = 48 * 1024 * 1024

// Cheap abuse guard: a passport with this many sessions already has to shed
// load before accepting more uploads. A plain COUNT(*) is cheap in D1.
export const SESSION_QUOTA_LIMIT = 1000

/** True once a passport has reached the per-passport session quota. */
export function sessionQuotaExceeded(count: number, limit = SESSION_QUOTA_LIMIT): boolean {
  return count >= limit
}

/**
 * The counted-byte guard applied to a raw octet-stream body: true once the
 * actually-read byte length exceeds the 48 MB ceiling. Also used as a fast
 * pre-check against a claimed content-length header before the body is read.
 */
export function rawBodyTooLarge(byteLength: number, limit = MAX_RAW_CIPHERTEXT_BODY_BYTES): boolean {
  return byteLength > limit
}

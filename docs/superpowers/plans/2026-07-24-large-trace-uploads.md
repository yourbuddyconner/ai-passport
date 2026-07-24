# Large Trace Uploads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make 67MB+ traces upload reliably: client-side size guard, gzip+base64 envelope (≈8-10× smaller bodies), and streaming (non-collecting) trace parsing in the enclave and worker.

**Architecture:** The browser gzips the `{passport_id, trace}` envelope with native `CompressionStream` before ECIES, and sends ciphertext as base64 (`ciphertextB64`) instead of hex. The worker accepts both wire fields (legacy hex stays valid), transcodes to hex for the enclave hop. The enclave, after ECIES decrypt, detects gzip magic bytes (`1f 8b`) and inflates via `flate2` before JSON-parsing the envelope — old plain envelopes still start with `{` and parse as before. `parse_trace` (Rust) and `parseTrace` (TS) stop materializing all lines up front: harness detection reads the first 10 parseable lines, then parsing consumes a lazy line iterator.

**Tech Stack:** CompressionStream (web), flate2 (Rust), existing qosCrypto ECIES (unchanged crypto), vitest + cargo test.

**Spec decisions (from the debugging session, user-approved):**
- Size guard: reject files > 256 MB raw at selection with a clear message; after compression+encryption, reject bodies > 90 MB client-side before POSTing (Cloudflare edge limit is 100 MB).
- Envelope format is content-detected, not version-fielded: gzip magic bytes vs `{`. No protocol version bump needed.
- Enclave version: 0.4.1. **DEPLOY ORDER IS LOAD-BEARING: enclave v0.4.1 must be live BEFORE the new web assets deploy** — a new client's gzipped envelope is undecodable by v0.4.0. Worker can deploy any time (it treats ciphertext as opaque).
- ECIES itself is unchanged — compression is inside the plaintext, base64 is outside the ciphertext.

## Global Constraints

- Legacy clients (cached JS sending hex + uncompressed) must keep working against both enclave versions — covered by explicit tests.
- TS worker fallback parser and Rust enclave parser keep behavioral parity (existing fixture tests must stay green untouched).
- Workspace clippy gates: unwrap/expect/panic denied, `cargo clippy --all-targets -- -D warnings` clean.
- Worker suite `npx vitest run` + `npx tsc --noEmit` clean; web `npm run build` clean.
- Commit per task; stage files by explicit path only (repo has GBs of untracked artifacts).

---

### Task 1: Web — gzip envelope, base64 ciphertext, size guards

**Files:**
- Modify: `web/src/lib/qosCrypto.ts` (add `bytesToBase64`; keep hex helpers for key parsing)
- Modify: `web/src/lib/api.ts` (`uploadTrace`, `uploadTraceAsOwner`: gzip → encrypt → base64; size guards; friendly errors)
- Modify: `web/src/pages/Dashboard.tsx` (pre-flight guard message for oversized files)

**Steps:**
- [ ] In `qosCrypto.ts` add:

```ts
/** Chunked base64 — String.fromCharCode has an argument-count limit. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export async function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
```

- [ ] In both upload functions: guard `file.size > 256 * 1024 * 1024` → return `{ok:false, error:'trace exceeds the 256 MB limit'}` without reading. Then: `envelope = JSON.stringify({passport_id, trace: text})` → `gzipBytes(encoded)` → `encryptToQuorumKey` (unchanged) → the encrypt function currently returns hex; convert its raw-bytes path so the caller gets bytes and base64s them (add `encryptToQuorumKeyRaw` returning `Uint8Array`, keep the hex wrapper for compatibility). POST body `{ciphertextB64}`. If `ciphertextB64.length > 90 * 1024 * 1024` → `{ok:false, error:'trace too large even after compression — split the session'}`.
- [ ] Also replace the hex `bytesToHex` hot path use for large payloads (no longer used for uploads once base64 lands; leave the function for small values).
- [ ] Verify: `cd web && npm run build`. Commit: `feat(web): gzip+base64 upload envelope with client-side size guards`

---

### Task 2: Worker — accept ciphertextB64 and PASS IT THROUGH (no transcode)

**Rationale (amended):** production is already throwing "worker exceeded resource
limits" on large Codex traces — the Worker must never materialize a hex copy of
a large ciphertext. The worker treats base64 ciphertext as an opaque string and
forwards it verbatim; the v0.4.1 enclave accepts base64 natively (Task 3).

**Files:**
- Modify: `worker/src/index.ts` (sessions POST: accept `{ciphertext}` hex OR `{ciphertextB64}`)
- Modify: `worker/src/verifier.ts` (analyze functions carry either encoding to the enclave: request body `{ciphertext}` for hex, `{ciphertext_b64}` for base64 — no conversion in the worker)
- Test: `worker/test/verifier.test.ts` (both wire fields produce the right enclave request body; neither-field still 400s)

**Steps:**
- [ ] TDD: mock the enclave fetch; assert `{ciphertextB64: X}` client body → enclave request `{ciphertext_b64: X}` verbatim, and `{ciphertext: Y}` → `{ciphertext: Y}` unchanged.
- [ ] Implement the pass-through. Legacy R2/storage fields that persist the ciphertext store whichever encoding arrived (check how `r2_key`/ciphertext storage works and keep it encoding-agnostic — read before assuming).
- [ ] Verify: `cd worker && npx vitest run && npx tsc --noEmit`. Commit: `feat(worker): pass-through base64 ciphertext envelopes (no hex materialization)`

---

### Task 3: Enclave — gunzip envelope + streaming parse, v0.4.1

**Files:**
- Modify: `verifier/Cargo.toml` (workspace version 0.4.1), `verifier/crates/passport-verifier/Cargo.toml` (`flate2 = "1"`)
- Modify: `verifier/crates/passport-verifier/src/handlers/analyze.rs` (request accepts `ciphertext` hex OR `ciphertext_b64` base64 — add base64 decode via the `base64` crate or a hand-rolled decoder consistent with lint gates; after decrypt: if plaintext starts `1f 8b`, inflate with a decompressed-size cap of 512 MB before serde parse; else parse as today)
- Modify: `verifier/crates/passport-verifier/src/parsers/mod.rs` (`parse_trace`: stop collecting `Vec<Value>`; detect harness from the first 10 parseable lines, then hand each parser a fresh line iterator)
- Modify: `verifier/crates/passport-verifier/src/parsers/claude_code.rs`, `codex.rs` (accept `impl Iterator<Item = Value>` instead of `&[Value]`; bodies are already single-pass loops)

**Steps:**
- [ ] TDD in analyze tests: a gzipped envelope round-trips identically to a plain one (same stats, same proof shape); a plain envelope still works (legacy client).
- [ ] TDD in parsers: existing fixture tests unchanged and green after the iterator refactor (that IS the parity test).
- [ ] Gunzip cap: `flate2::read::GzDecoder` wrapped in `.take(512 * 1024 * 1024)` — a zip-bomb must error cleanly (AppError 422), not OOM.
- [ ] Verify: `cargo test -p passport-verifier && cargo test -p e2e && cargo clippy --all-targets -- -D warnings`. Commit: `feat(verifier): gunzip envelopes + streaming parse, v0.4.1`

---

### Task 4: Worker fallback parser — streaming parity

**Files:**
- Modify: `worker/src/parsers/index.ts` (`parseTrace`: lazily split/parse lines via generator instead of materializing `unknown[]`; harness sniff from first 10 parsed lines)
- Modify: `worker/src/parsers/claudeCode.ts`, `codex.ts` (signatures accept `Iterable<unknown>`; loops unchanged)

**Steps:**
- [ ] Existing parser tests stay green untouched (arrays are Iterables — fixtures need no changes).
- [ ] Verify: `cd worker && npx vitest run && npx tsc --noEmit`. Commit: `feat(worker): streaming trace parse in fallback path`

---

### Task 5: Ship

- [ ] Full sweep: worker vitest+tsc, cargo test+clippy, web build.
- [ ] Adversarial compat review (fresh reviewer): the 2×2 matrix (old/new client × v0.4.0/v0.4.1 enclave), zip-bomb cap, base64 edge cases (padding, chunk boundaries), 90 MB guard math, memory arithmetic at 67 MB and 256 MB.
- [ ] Merge to master.
- [ ] Build + push enclave image v0.4.1 (`BUILDX_BUILDER=tvc-builder`), update `deploy.json` digests, commit.
- [ ] USER: `tvc deploy create --config-file deploy.json` + `tvc deploy approve` (permission-gated).
- [ ] Controller: `tvc app set-live-deploy`, verify signed-proof probe, THEN `wrangler deploy` (worker+web last — deploy order is load-bearing), re-pin `deployment.ts`, final 67 MB end-to-end probe with a real large local trace.

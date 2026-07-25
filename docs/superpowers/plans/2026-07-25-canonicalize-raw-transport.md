# Canonicalization + Raw Binary Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unblock large traces two ways at once: client-side canonicalization (strip parser-irrelevant bytes: Codex `compacted` blobs → timestamp-preserving stubs, Claude base64 image payloads → placeholders) and a raw-binary upload transport (no JSON wrap, no base64) with a 64MB-ciphertext ceiling and an enclave v0.4.2 that stream-parses without ever materializing the decompressed trace.

**Design authority:** the adversarial design review of 2026-07-25 (see `.superpowers/sdd/progress.md` ledger). Key verdicts baked in: single-POST ceiling ~100MB imposed by two Cloudflare zones; chunked-to-enclave impossible (stateless replicas, no egress); do NOT build chunked AEAD, R2 multipart reassembly, or `tee()`.

**Architecture:** Browser canonicalizes → gzips the RAW TRACE TEXT (not a JSON envelope) → builds a binary envelope `u16-LE passport_id length ‖ passport_id utf8 ‖ gzip bytes` → ECIES-encrypts → POSTs raw ciphertext as `application/octet-stream`. Worker buffers ≤64MB (counted bytes, not trusted headers) and forwards octet-stream to the enclave's new `POST /analyze_raw` (body limit 96MB). Enclave decrypts (dropping the request body first), parses the framing, and streams: GzDecoder → cap-counting + SHA-256-hashing reader → line iterator → existing `impl Iterator<Item = Value>` parsers. `trace_sha256` = hash of the inflated trace bytes (identical semantics to today: it binds what was analyzed). AnalyzePayload/proof format unchanged. Legacy JSON routes (`{ciphertext}`, `{ciphertextB64}`, enclave `/analyze`) stay for one release.

## Global Constraints

- Canonicalization MUST be stats-neutral: parsers over original vs canonicalized fixtures produce identical SessionStats. Codex reads timestamps from EVERY line (`codex.rs` timestamp min/max) — stubs must preserve `timestamp`.
- Enclave: no full-trace String, no Vec growth-doubling (use capped incremental `reserve_exact` or fixed read buffers); peak memory ≤ ~2.2× ciphertext. Workspace lints (unwrap/expect/panic denied, clippy -D warnings) hold.
- Worker never materializes more than one copy of the ciphertext (~64MB in a 128MB isolate).
- Size chain (enforced by counted bytes where marked): client raw file ≤ 256MB → client ciphertext ≤ 64MB → worker body ≤ 64MB (counted) → enclave `/analyze_raw` body limit 96MB → inflate cap 192MB (streamed counter, not a buffer bound).
- Legacy compatibility: old cached web JS (ciphertextB64) and API hex uploads keep working against worker+enclave throughout.
- Deploy order: enclave v0.4.2 live and re-probed at real sizes BEFORE worker+web ship.
- Tests: worker `npx vitest run` + `npx tsc --noEmit`; verifier `cargo test -p passport-verifier && cargo test -p e2e && cargo clippy --all-targets -- -D warnings`; web `npm run build`. Commit per task, explicit paths only.

---

### Task 1: Canonicalization module + parity tests

**Files:**
- Create: `web/src/lib/canonicalize.ts`
- Test: `worker/test/canonicalize.test.ts` (vitest imports the web module by relative path — keeps the browser module test-covered despite web having no test runner)

**Spec:**
- `canonicalizeTrace(text: string): string` — line-oriented; non-JSON lines pass through verbatim; unknown shapes pass through verbatim; output lines joined with `\n` preserving trailing newline presence.
- Codex: any line whose payload/top-level `type` is `compacted` → replace with a minimal stub retaining the original top-level `type` and `timestamp` fields (inspect a REAL rollout first: `ls -S ~/.codex/sessions/2026/*/*/rollout-*.jsonl | head -3`, find a `compacted` line, match its actual nesting). Also stub `reasoning`/`agent_reasoning` payload text the same way (keep type+timestamp shell).
- Claude Code: inside `message.content` arrays, any block of `type: 'image'` gets `source.data` replaced by `''`; `toolUseResult` fields of `type: 'image'` similarly. Timestamps and all other fields untouched.
- Parity tests: run `parseClaudeCode`/`parseCodex` (import from worker/src/parsers) over fixtures containing compacted/reasoning/image lines, assert `JSON.stringify(stats)` identical for original vs canonicalized input; plus a shrinkage assertion (canonicalized shorter). Include a fixture where `compacted` carries the max timestamp — endedAt must not change.

Steps: TDD (tests → fail → implement → pass → full worker suite) → commit `feat(web): stats-neutral trace canonicalization`.

---

### Task 2: Web — binary envelope + raw upload

**Files:**
- Modify: `web/src/lib/qosCrypto.ts` (add `buildBinaryEnvelope(passportId: string, gzBytes: Uint8Array): Uint8Array` — u16-LE length prefix ‖ utf8 passport id ‖ gz bytes)
- Modify: `web/src/lib/api.ts` (both upload functions: canonicalize → gzip RAW trace text → buildBinaryEnvelope → `encryptToQuorumKeyRaw` → POST the raw `Uint8Array` body, `content-type: application/octet-stream`, same auth headers; guards: file.size > 256MB reject; ciphertext byteLength > 64MB reject with 'trace too large even after compression — split the session'; plaintext fallback branch unchanged incl. its 25MB guard)

Note: gzip now wraps ONLY the trace text; passport binding moves into the binary framing (still inside the encryption). Remove the JSON-envelope construction from these paths; delete `bytesToBase64` usage here (keep the function).

Steps: implement → `npm run build` clean → commit `feat(web): canonicalize + raw binary upload envelope`.

---

### Task 3: Worker — octet-stream branch + quota guard

**Files:**
- Modify: `worker/src/index.ts` (sessions POST: when `content-type` is `application/octet-stream`, read the body via `c.req.arrayBuffer()` with a counted-size check (reject > 64MB AFTER reading actual bytes; also pre-check content-length when present); pass `Uint8Array` to the verifier client; legacy JSON branch untouched. Add a cheap abuse guard: reject upload when the passport already has ≥ 1000 sessions (D1 count query) with a clear 429-style message.)
- Modify: `worker/src/verifier.ts` (`analyzeCiphertextRaw(bytes: Uint8Array)`: POST octet-stream with explicit content-length to `${VERIFIER_URL}/analyze_raw`; response handling identical to `/analyze` (same proof/stats shape, mapRustStats, hasV2Metrics — v0.4.2 always has v2). R2 storage on this path stores the raw bytes (check the TRACES binding actually exists in wrangler.jsonc — the design review claims the r2_buckets block is commented out; investigate how `TRACES.put` currently works and preserve whatever conditional behavior exists, storing bytes not strings on the new path.)
- Test: `worker/test/verifier.test.ts` — mock fetch: raw bytes → `/analyze_raw` octet-stream with correct content-length; oversized counted body → clean 413.

Steps: TDD → full worker suite + tsc → commit `feat(worker): raw ciphertext branch with counted-byte guards`.

---

### Task 4: Enclave v0.4.2 — /analyze_raw with streaming parse

**Files:**
- Modify: `verifier/Cargo.toml` (workspace 0.4.1 → 0.4.2)
- Modify: `verifier/crates/passport-verifier/src/router.rs` (route `/analyze_raw` post, with per-route body limit 96MB — axum `DefaultBodyLimit::max` layered on the route; existing routes unchanged)
- Modify: `verifier/crates/passport-verifier/src/handlers/analyze.rs`:
  - `analyze_raw(State, body: Bytes)`: decrypt via quorum key; `drop(body)` immediately after; parse framing (u16-LE len, bounds-checked; utf8 passport_id; remainder must start with gzip magic else 400).
  - Streaming pipeline: a reader adapter over the gzip payload → `GzDecoder` → wrapper `Read` impl that (a) counts inflated bytes and errors past 192MB, (b) feeds a running `Sha256`. `BufReader::lines()` over it → `filter_map(serde_json parse)` → head-sniff first 10 Values into a Vec, choose parser via existing `looks_like`, then `head.into_iter().chain(rest)` into the existing `impl Iterator<Item = Value>` parsers. NO full-trace String anywhere.
  - `trace_sha256` = finalized hash after the line iterator is exhausted (drain any remaining reader bytes before finalizing so trailing data is hashed — or reject trailing non-newline data as 422; pick one, document, test it).
  - Same AnalyzePayload/proof construction as `/analyze`.
  - ALSO fix the legacy path's Vec-doubling spike in `maybe_inflate` (reserve in bounded increments or `with_capacity(min(cap, hint))` — the review's B4.4).
- Tests: raw-path round trip (framing → same stats and same trace_sha256 as the JSON path for the same trace); framing corruption cases (len OOB, bad utf8, no gzip magic) → 4xx; streamed cap exceeded → 422; e2e: `/analyze_raw` end-to-end with signature verification.

Steps: TDD → cargo test + e2e + clippy clean → commit `feat(verifier): /analyze_raw streaming pipeline — v0.4.2`.

---

### Task 5: Ship (staged, gated)

- [ ] Full sweep (all three stacks) + adversarial re-review (compat matrix incl. cached-JS states; enclave memory recount at 64MB ciphertext; canonicalization stats-parity on REAL local traces — run both parsers over `~/.claude/projects` and `~/.codex/sessions` samples, original vs canonicalized, assert identical stats at scale).
- [ ] Merge to master.
- [ ] Enclave v0.4.2: reproducible build (`BUILDX_BUILDER=tvc-builder`), push image, stage deploy.json, USER runs `tvc deploy create` + `approve`, controller runs `set-live-deploy`.
- [ ] GATE: re-probe `/analyze_raw` on the live ingress with REAL consuming bodies at 8/32/64MB (garbage ciphertext → expect enclave 400 decrypt errors, NOT 502/413). If 502s persist at 32-64MB against the consuming endpoint, STOP — reduce the ciphertext ceiling to the largest clean size and adjust guards before shipping web.
- [ ] Deploy worker+web, re-pin deployment.ts, push.
- [ ] Final probes: the 91MB Codex rollout and the 65MB Claude trace end-to-end via the new client path (canonicalize → raw upload) — both must return 201 enclave-verified with plausible stats; delete probe rows after.

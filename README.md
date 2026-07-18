# AI Passport

Upload session traces from your AI coding harness (Claude Code, Codex CLI) and get a shareable
**Verified AI Use** card — proof-of-fluency you can send to employers.

- **Backend**: Cloudflare Worker (Hono) + D1 + R2
- **Frontend**: Vite + React + TypeScript + Tailwind v4 + shadcn-style components, served as
  static assets by the Worker
- **Verifier**: a [Turnkey Verifiable Cloud](https://docs.turnkey.com/features/verifiable-cloud/overview)
  enclave app (`verifier/`, Rust) that analyzes traces as a stateless coprocessor and signs the
  results (app proofs). Only aggregate statistics and quorum-encrypted ciphertext are stored —
  never plaintext code or prompts.

## Layout

- `worker/` — Hono API, trace parsers (`src/parsers/`), scoring (`src/score.ts`), enclave
  client + proof verification (`src/verifier.ts`), D1 `schema.sql` + `migrations/`
- `web/` — Vite frontend (Home upload flow, public card at `/p/:slug`, `/about` verification page)
- `verifier/` — TVC enclave app (see its README); Rust ports of the parsers + `/analyze` endpoint
- `docs/superpowers/specs/` — design doc

## Where traces live

- Claude Code: `~/.claude/projects/<project>/<session-id>.jsonl`
- Codex CLI: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`

## Develop

Requires Node ≥ 22 for wrangler (Vite works on 20+).

```sh
cd verifier && make run &                        # local enclave app on :44020 (dev keys)
cd web && npm install && npm run build           # build frontend into web/dist
cd ../worker && npm install
npx wrangler d1 execute ai-passport --local --file=schema.sql
npx wrangler dev                                 # http://localhost:8787
```

`worker/.dev.vars` sets `VERIFIER_URL=http://localhost:44020` so local uploads go through the
enclave path (verification: `enclave`, signed proofs). Without a reachable verifier the Worker
falls back to in-process parsing (verification: `format`). The local verifier is byte-identical
to the TVC production app; production adds Nitro attestation of the keys, gated behind
`VERIFIER_ATTESTED=true` + the attestation checks in `worker/src/verifier.ts`.

For frontend iteration: `cd web && npm run dev` (proxies `/api` to :8787).

Tests: `cd worker && npx vitest run`

## Deploy

```sh
npx wrangler login
npx wrangler d1 create ai-passport               # copy database_id into wrangler.jsonc
npx wrangler d1 execute ai-passport --remote --file=schema.sql
cd ../web && npm run build
cd ../worker && npx wrangler deploy
```

## API

- `POST /api/passports` `{name}` → `{id, slug, editToken}`
- `POST /api/passports/:id/sessions` (header `x-edit-token`, body: raw JSONL) → parsed session stats; duplicates are skipped
- `GET /api/passports/slug/:slug` → public card data (aggregates + fluency score)

## Scoring

Transparent 0–100 score: session volume (≤25), distinct-tool breadth (≤25), multi-harness
bonus (15), output tokens (≤20), active-day consistency (≤15). Grades: Novice / Practitioner /
Power User / AI-Native. The breakdown is shown on every card.

**Verification honesty**: MVP verification is *format-verified* — the trace parsed as a genuine
harness log with consistent structure. Cryptographic attestation is future work.

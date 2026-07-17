# AI-PASSPORT MVP — Design

Date: 2026-07-17

## Purpose

A web tool where you upload session traces from your AI coding harness (Claude Code, Codex CLI) and get a shareable "Verified AI Use" card — proof-of-fluency you can send to employers.

## Architecture

Single Cloudflare Worker deployment:

- **Worker** (`worker/`): Hono app. Serves the API under `/api/*` and the built Vite frontend via the Workers static assets binding. Uses **D1** for storage.
- **Frontend** (`web/`): Vite + React + TypeScript + Tailwind v4 + shadcn-style components. Built output is served by the Worker.
- **Shared parsers** (`worker/src/parsers/`): pure functions that turn raw JSONL trace text into a normalized `SessionStats` object. Unit-tested with Vitest against fixtures derived from real (sanitized) traces.

## Data flow

1. User creates a passport (display name → server generates ID + shareable slug + secret edit token).
2. User drops one or more `.jsonl` trace files. Frontend POSTs raw text to `POST /api/passports/:id/sessions` (with edit token).
3. Worker detects harness (Claude Code vs Codex) from line shape, parses line-by-line, stores **aggregate stats only** — never the raw trace (privacy: traces contain code and prompts).
4. Card page `GET /p/:slug` renders aggregates: total sessions, active hours, tool calls, tokens, models, harnesses, top tools, date range, and a computed fluency grade.

## Harness detection & parsing

- **Claude Code**: lines with `sessionId` + `type` in {user, assistant}; assistant lines carry `message.model`, `message.usage.{input_tokens,output_tokens}`, and `message.content[].type === "tool_use"` with `name`.
- **Codex**: first line `type: "session_meta"` with `payload.id`; `response_item` payloads of type `function_call` (tool name), `message`; `turn_context.payload.model`; last `event_msg` of type `token_count` gives `info.total_token_usage`.

Normalized per-session output:

```ts
interface SessionStats {
  harness: 'claude-code' | 'codex'
  externalId: string        // session UUID from trace, used for dedup per passport
  startedAt / endedAt: ISO strings
  messageCount, toolCallCount: number
  inputTokens, outputTokens: number
  models: string[]
  toolCounts: Record<string, number>
}
```

## D1 schema

- `passports(id TEXT PK, slug TEXT UNIQUE, name TEXT, edit_token TEXT, created_at TEXT)`
- `sessions(id TEXT PK, passport_id FK, harness TEXT, external_id TEXT, started_at, ended_at, message_count, tool_call_count, input_tokens, output_tokens, models TEXT/*json*/, tool_counts TEXT/*json*/, created_at)` with UNIQUE(passport_id, external_id) for dedup.

## Fluency grade

Simple transparent score (0–100) from: session volume, distinct tools breadth, multi-harness use, total assistant output tokens, and span of active days. Mapped to grades (Novice / Practitioner / Power User / AI-Native). Displayed with the formula's inputs — no black box.

## Honesty note

MVP verification = "format-verified": the trace parsed as a genuine harness log with consistent structure and timestamps. The card states this. Cryptographic attestation is out of scope.

## API

- `POST /api/passports` `{name}` → `{id, slug, editToken}`
- `POST /api/passports/:id/sessions` (header `x-edit-token`) body: raw JSONL text → parsed stats or 4xx
- `GET /api/passports/slug/:slug` → aggregate card data (public, no token)
- `DELETE /api/passports/:id` (token) — out of MVP if time-constrained

## Error handling

Unparseable file → 422 with reason. Duplicate session → skipped, reported in response. Upload cap 25 MB.

## Testing

Vitest unit tests for both parsers (fixtures), aggregate/score functions, and API integration tests via `@cloudflare/vitest-pool-workers` if setup cost is low, else parser+logic coverage only for MVP.

# Leaderboard & Team Ladders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opt-in global leaderboard + private invite team ladders, ranked by enclave-verified score, with rank-preview conversion prompts and podium OG images. Worker + web only — NO enclave changes.

**Architecture:** `verified_score` is denormalized on `passports`, recomputed on upload/reprocess/delete/list. Ladders are two tiny tables; membership is separate from the global `listed` flag. All ranking reads are indexed ORDER BYs. The web adds two path-regex routes and reuses the existing card components.

**Tech Stack:** Hono + D1 (worker), React + Tailwind (web), vitest.

**Spec:** `docs/superpowers/specs/2026-07-25-leaderboard-design.md` — binding for copy, gating rules, and rank display rules.

## Global Constraints

- Ranking counts ONLY sessions with `verification = 'enclave'`.
- A passport appears on the global page / ladder pages ONLY with ≥1 enclave-verified session (0-verified members count in a `pending` tally, never as rows).
- Card/OG "#N of M" renders ONLY when `listedCount >= 25`. Ladder ranks are exempt (shown on ladder pages at any size).
- Spotlights: exactly two (Lines Shipped, Sessions Concluded), enforced-distinct winners (a slug wins at most one).
- Trust copy verbatim on /leaderboard: "Every rank is backed by enclave-attested sessions." No hedging fine-print on the page (that lives on /about).
- Ladder invite_code is 128-bit random hex; viewing needs slug only, joining needs the code; ≤5 ladders created per passport; last member leaving deletes the ladder.
- Auth for mutations: passkey-session owner OR x-edit-token (extract the existing repeated check into a helper — see Task 1).
- Tests: `cd worker && npx vitest run && npx tsc --noEmit` green per task; web `npm run build`. Commit per task, explicit paths only (repo has GBs of untracked artifacts — NEVER `git add -A`).

---

### Task 1: Migration, verified_score recompute, auth helper

**Files:**
- Create: `worker/migrations/0006_leaderboard.sql`
- Modify: `worker/schema.sql` (mirror all of 0006)
- Create: `worker/src/ranking.ts`
- Modify: `worker/src/index.ts` (recompute calls; extract `authorizePassport`)
- Test: `worker/test/ranking.test.ts`

**Interfaces:**
- Produces: `computeVerifiedScore(rows: SessionRow[]): number` (pure — aggregate() over pre-filtered rows, rounded); `recomputeVerifiedScore(db: D1Database, passportId: string): Promise<number>` (SELECTs `verification='enclave'` rows with all SessionRow columns, calls the pure fn, UPDATEs passports.verified_score, returns it); `authorizePassport(c, passportId): Promise<{passport, isOwner} | Response>` (the existing cookie-OR-edit-token block from index.ts:262-275, extracted verbatim; returns the 404/403 Response when unauthorized).

- [ ] **Step 1: Migration**

```sql
-- worker/migrations/0006_leaderboard.sql
ALTER TABLE passports ADD COLUMN listed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE passports ADD COLUMN verified_score INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS ladders (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  invite_code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES passports(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ladder_members (
  ladder_id TEXT NOT NULL REFERENCES ladders(id),
  passport_id TEXT NOT NULL REFERENCES passports(id),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (ladder_id, passport_id)
);
CREATE INDEX IF NOT EXISTS idx_passports_listed ON passports(listed, verified_score);
CREATE INDEX IF NOT EXISTS idx_ladder_members_passport ON ladder_members(passport_id);
```

Mirror in `worker/schema.sql` (columns on the passports CREATE TABLE + the two tables + indexes).

- [ ] **Step 2: Failing tests for the pure scorer**

```ts
// worker/test/ranking.test.ts
import { describe, expect, it } from 'vitest'
import { computeVerifiedScore } from '../src/ranking'
import type { SessionRow } from '../src/score'

// reuse the row() helper pattern from score.test.ts (copy it in)
it('scores only what it is given and rounds', () => {
  const rows: SessionRow[] = [row({ output_tokens: 10_000_000, loc_added: 5000, outcome: 'shipped' })]
  const s = computeVerifiedScore(rows)
  expect(Number.isInteger(s)).toBe(true)
  expect(s).toBeGreaterThan(0)
})
it('zero rows → zero', () => expect(computeVerifiedScore([])).toBe(0))
```

- [ ] **Step 3: Implement ranking.ts**

```ts
// worker/src/ranking.ts
import { aggregate, type SessionRow } from './score'

/** Score over an already-filtered (enclave-verified) row set. */
export function computeVerifiedScore(rows: SessionRow[]): number {
  if (rows.length === 0) return 0
  return Math.round(aggregate(rows).score)
}

const SESSION_COLUMNS = `harness, started_at, ended_at, message_count, tool_call_count,
  input_tokens, output_tokens, models, tool_counts, project_hash, loc_added, loc_removed,
  languages, command_counts, human_turns, agenticity, longest_run, parallel_batches,
  delegation_calls, verified_edit_cycles, red_green_cycles, outcome, skills, mcp_servers,
  background_tasks`

export async function recomputeVerifiedScore(db: D1Database, passportId: string): Promise<number> {
  const { results } = await db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE passport_id = ? AND verification = 'enclave'`)
    .bind(passportId)
    .all<SessionRow>()
  const score = computeVerifiedScore(results ?? [])
  await db.prepare('UPDATE passports SET verified_score = ? WHERE id = ?').bind(score, passportId).run()
  return score
}
```

- [ ] **Step 4: Extract authorizePassport in index.ts** — move the repeated cookie-OR-token block (used by sessions POST and session DELETE) into one helper near the top; both call sites use it. Byte-identical behavior (same 404/403 bodies).

- [ ] **Step 5: Wire recompute** — call `recomputeVerifiedScore(c.env.DB, id)` after: successful session INSERT, successful reprocess UPDATE, and session DELETE. Fire-and-forget is NOT ok (D1 needs await); await it after the response data is assembled but before returning.

- [ ] **Step 6: Apply migration locally, full suite**

```bash
cd worker && npx wrangler d1 execute ai-passport --local --file=migrations/0006_leaderboard.sql
npx vitest run && npx tsc --noEmit
```

- [ ] **Step 7: Commit** — `git add worker/migrations/0006_leaderboard.sql worker/schema.sql worker/src/ranking.ts worker/src/index.ts worker/test/ranking.test.ts && git commit -m "feat(worker): verified_score denormalization + ladder schema"`

---

### Task 2: Leaderboard + listing endpoints

**Files:**
- Modify: `worker/src/index.ts`
- Modify: `worker/src/ranking.ts` (leaderboard query helpers)
- Test: `worker/test/ranking.test.ts` (append)

**Interfaces:**
- Consumes: `recomputeVerifiedScore`, `authorizePassport` (Task 1).
- Produces:
  - `PATCH /api/passports/:id` body `{listed: boolean}` → `{listed, verifiedScore}`; auth via authorizePassport; on listed=true also recompute.
  - `GET /api/leaderboard` → `{total, entries: [{rank, slug, name, grade, verifiedScore, sessions, locAdded, concludedSessions}], spotlights: {linesShipped: {slug,name,value} | null, concluded: {...} | null}}` with `Cache-Control: public, max-age=60`. Entries: `listed = 1 AND verified_score's passport has ≥1 enclave session` — implement as a JOIN/EXISTS, ORDER BY verified_score DESC, created_at ASC. Grade derived from verified_score using the GRADES table exported from score.ts (export it if not already).
  - Spotlight helper `pickSpotlights(entries, perEntryStats)` in ranking.ts: linesShipped winner first; concluded winner = best slug ≠ linesShipped winner (enforced distinct).
  - Card payloads: in `/api/passports/slug/:slug` and `/api/me`, when the passport is listed, add `globalRank` (1-based position among listed by the same ORDER) and `listedCount`; when `listedCount < 25`, OMIT `globalRank` from the public slug payload entirely (dashboard /api/me always gets it — the private preview). ALSO in /api/me: when NOT listed, include `rankIfListed` computed the same way with the passport hypothetically included.

- [ ] Tests (write first, watch fail): endpoint shape via direct handler-logic tests where route-testing isn't available — put the rankable logic in ranking.ts pure functions (`rankEntries(rows)`, `pickSpotlights`) and test those: ordering by score desc then created_at asc; zero-verified passports excluded; distinct spotlight winners (fixture where one slug leads both metrics → second spotlight goes to runner-up); `rankIfListed` insertion position; listedCount floor omission logic (pure fn `includeGlobalRank(listedCount)` → false below 25).
- [ ] Implement, full suite, commit: `feat(worker): leaderboard + listing endpoints with small-N shielding`

---

### Task 3: Ladders API

**Files:**
- Modify: `worker/src/index.ts` (four routes)
- Modify: `worker/src/ranking.ts` (shared entry-shaping reused by ladder GET)
- Test: `worker/test/ranking.test.ts` (append pure-logic tests) — route auth logic factored into testable helpers where the codebase pattern allows.

**Interfaces (all JSON):**
- `POST /api/ladders` `{name, passportId}` + auth headers → 201 `{id, slug, inviteCode}`. Validates name 1-64 chars. Enforces ≤5 ladders per creator (COUNT on created_by → 429-style 400 'ladder limit reached (5)'). Slug: reuse the passport slug generator pattern (find it in index.ts — same word-word-hex shape). invite_code: `crypto.randomUUID().replace(/-/g,'') + crypto.randomUUID().replace(/-/g,'')` truncated to 32 hex chars. Creator auto-joins (INSERT into ladder_members).
- `POST /api/ladders/:slug/join` `{inviteCode, passportId}` + auth → 200 `{joined: true}`; wrong code → 403; already member → 200 idempotent.
- `DELETE /api/ladders/:slug/membership` `{passportId}` + auth → 200; if the leaver was the last member, DELETE the ladder row too.
- `GET /api/ladders/:slug` (public, no auth) → `{name, total, pending, entries}` — members with ≥1 enclave-verified session ranked as in Task 2 (reuse the entry-shaping helper); `pending` = member count with zero verified sessions. 404 unknown slug. NEVER returns invite_code.
- All mutations authorize the ACTING passport via authorizePassport (the passportId in the body must be the authorized one).

- [ ] Tests first (pure helpers + fixtures): ladder cap, invite-code shape (32 hex), idempotent join, last-leaver-deletes decision helper, entries exclude zero-verified with pending count.
- [ ] Implement, full suite, commit: `feat(worker): team ladders API`

---

### Task 4: Podium OG images

**Files:**
- Modify: `worker/src/og.ts` (add `renderPodiumOg(title: string, entries: Array<{name, grade, score}>): string` — top-3 podium, reusing loadFont/esc/stat/mrzLine helpers and the existing visual language; entries.length may be 1-3)
- Modify: `worker/src/index.ts` (routes `GET /og/leaderboard` and `GET /og/ladder/:slug` → renderPodiumOg over the same data as the JSON endpoints; same caching headers as the card OG route — read how /og/:slug does it and mirror)
- Also: the HTML shell for /leaderboard and /l/:slug needs og:image meta — find how /p/:slug injects card meta (worker serves index.html with meta rewrite? check index.ts around the /p/ handling) and mirror for the two new paths.

- [ ] Implement (visual: podium center-tall layout, grade seal colors consistent with GradeSeal.tsx), verify by running `npx wrangler dev` and curling /og/leaderboard → 200 image/svg+xml (or whatever content type card OG uses).
- [ ] Full suite + commit: `feat(worker): podium OG for leaderboard and ladder pages`

---

### Task 5: Web — pages and client

**Files:**
- Modify: `web/src/lib/api.ts` (types + fns: `getLeaderboard()`, `getLadder(slug)`, `createLadder(name, ...auth)`, `joinLadder(slug, code, ...auth)`, `leaveLadder(slug, ...auth)`, `setListed(id, listed, ...auth)` — mirror existing fn auth patterns for both edit-token and cookie callers)
- Create: `web/src/pages/Leaderboard.tsx`
- Create: `web/src/pages/Ladder.tsx`
- Modify: `web/src/App.tsx` (path-regex routes: `/^\/leaderboard\/?$/` and `/^\/l\/([\w-]+)\/?$/`, both public like /about)
- Modify: `web/src/pages/Landing.tsx` + card footer in `Passport.tsx` (link to /leaderboard)

**Leaderboard.tsx:** header + trust line ("Every rank is backed by enclave-attested sessions."), two spotlight mini-cards, ranked table (rank, name → /p/:slug, GradeSeal, verified score, sessions, lines shipped). Thin/empty state: "Start a ladder with your team" CTA → dashboard, plus the trace-finder one-liner in a copyable code block: `ls ~/.claude/projects/*/*.jsonl ~/.codex/sessions/*/*/*/*.jsonl`.

**Ladder.tsx:** ladder name, member count + pending count, same table component (extract the table into `web/src/components/RankTable.tsx` shared by both pages), join flow: if URL has `?join=<code>` and user has a passport session, show "Join this ladder" button calling joinLadder; success → row appears. Members see an "Invite" button copying `${location.origin}/l/${slug}?join=${inviteCode}` — inviteCode comes from creation response or /api/me ladders listing (Task 6 adds it there; ladder GET never returns it — only /api/me does, for the caller's own ladders).

- [ ] Implement, `npm run build` clean, commit: `feat(web): leaderboard and ladder pages`

---

### Task 6: Web — dashboard conversion mechanics

**Files:**
- Modify: `worker/src/index.ts` (`/api/me` gains: `rankIfListed`, `listed`, `listedCount`, `ladders: [{slug, name, rank, size, inviteCode}]` for the caller's own memberships)
- Modify: `web/src/lib/api.ts` (Me type)
- Modify: `web/src/pages/Dashboard.tsx`:
  - Listed toggle card: switch + current state; when unlisted shows "You'd be **#{rankIfListed} of {listedCount + 1}** if listed"; when listed shows current global rank.
  - Pride-moment prompt: after `handleFiles` completes with ≥1 accepted non-duplicate result AND user is unlisted AND `localStorage.getItem('lb-prompt-dismissed') !== '1'`: inline banner "You'd be #{rankIfListed} of {listedCount + 1} on the leaderboard — list your passport?" [List me → setListed(true) + refresh] [Not now → localStorage set + hide]. One-time, never nag.
  - "Your ladders" card: list memberships with rank/size + invite-copy button; "Create a ladder" input + button.

- [ ] Implement, build clean, commit: `feat(web): rank preview, pride-moment prompt, ladders dashboard`

---

### Task 7: Ship

- [ ] Full sweep: worker vitest + tsc, web build.
- [ ] Adversarial review (fresh reviewer): auth on every mutation (cross-passport listing/joining with someone else's passportId), invite-code leakage (GET ladder must never return it; only /api/me), recompute correctness vs on-read scores (drift), rank-floor omission actually omits (public payload with listedCount<25 has NO globalRank key), quota/caps, empty states, OG rendering with 1 entry.
- [ ] Fix round if needed, merge to master.
- [ ] Deploy: `npx wrangler d1 execute ai-passport --remote --file=migrations/0006_leaderboard.sql` FIRST (new worker names new columns — same ordering rule as 0005, documented in README), then `cd web && npm run build && cd ../worker && npx wrangler deploy`.
- [ ] Probes: create a test ladder end-to-end via API, verify GET shapes, verify /og/leaderboard renders, verify card payload rank-floor omission on production, delete test data.
- [ ] Backfill: run a one-off remote SQL to recompute verified_score for the 12 existing passports? NO — recompute is upload-triggered; instead run a one-off script hitting an admin-less path: simplest is a temporary local script calling recomputeVerifiedScore per passport via `wrangler d1 execute` equivalent SQL is impractical (score logic is in TS). Do it via a temporary probe: for each existing passport, PATCH listed=false→ no... ADD to Task 2: PATCH {listed} ALWAYS recomputes (both directions) — then the backfill is: owner PATCHes each of their passports (or we accept scores populate on next upload). Decision recorded: PATCH always recomputes; existing passports show 0 until touched — acceptable, pre-seed outreach (rollout step 0) includes asking people to re-toggle or upload once.
- [ ] Rollout step 0 (founder): DM the 9 active passport holders — get ≥7 listed or into the first ladder BEFORE announcing.

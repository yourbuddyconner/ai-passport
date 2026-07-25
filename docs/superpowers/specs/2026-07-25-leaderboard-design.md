# Leaderboard & Discovery — Design

**Date:** 2026-07-25
**Status:** Approved design, pre-implementation

## Goal

A public `/leaderboard` page that closes the growth loop: browsing real verified
cards makes people create passports. Opt-in listing, enclave-verified ranking,
and rank propagation onto the shareable card/OG image (every card share
advertises the ladder).

Grounding at design time: 12 passports, 9 with sessions, 3,263 sessions.

## Decisions (user-approved)

- **Purpose:** growth loop — gallery/ranking hybrid, optimized for the page
  being shareable and cards being clickable. Not a talent directory (yet).
- **Listing:** opt-in only, default off. A dashboard toggle; delist any time.
  Consistent with the privacy posture (E2E encryption, pseudonymous slugs).
- **Trust:** ranked by score over **enclave-verified sessions only**
  (`verification = 'enclave'`). Format-verified sessions still show on cards
  but contribute zero to ranking. Stated plainly on the page.
- **Provenance without replay:** the enclave counts vendor-signed material it
  observes — Claude thinking-block `signature` fields, Codex reasoning
  `encrypted_content` — into a per-session `signed_blocks` count carried in
  the attested stats. Displayed as "vendor-signed blocks present"; NEVER
  validated (Fernet/symmetric — only the vendors can verify) and NEVER ranked.
  The replay-oracle provenance badge is explicitly out of scope.

## Data model

```sql
ALTER TABLE passports ADD COLUMN listed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE passports ADD COLUMN verified_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN signed_blocks INTEGER NOT NULL DEFAULT 0;
```

- `verified_score`: denormalized. Recomputed inside the sessions POST (upload,
  reprocess) and session DELETE handlers: aggregate over the passport's
  enclave-verified rows only, store `Math.round(score)`. Leaderboard reads are
  a single indexed ORDER BY — no per-view score computation, ever.
- `signed_blocks`: new SessionStats field (camelCase `signedBlocks`), parsed in
  BOTH parsers with fixture parity:
  - Claude Code: count content blocks (assistant lines, main chain only)
    carrying a string `signature` field.
  - Codex: count `response_item` payloads carrying a string
    `encrypted_content` field.
  - Enclave v0.4.3 (parser change → new pivot digest → full TVC deploy).
  - mapRustStats + D1 columns + SessionRow + aggregate() thread it through;
    zero-fill semantics identical to the other v2 fields (old enclave → 0,
    preserveV2 guards apply unchanged).

## API

- `PATCH /api/passports/:id` body `{listed: boolean}` — edit-token or passkey
  session auth (same guard as uploads). Also recomputes `verified_score` on
  the transition to listed (covers passports whose sessions predate the
  denormalization).
- `GET /api/leaderboard` (public, `Cache-Control: public, max-age=60`):
  ```json
  {
    "total": 7,
    "entries": [{ "rank": 1, "slug": "...", "name": "...", "grade": "...",
                   "verifiedScore": 71, "sessions": 214, "locAdded": 84021,
                   "concludedSessions": 41, "signedBlocks": 12044 }],
    "spotlights": {
      "linesShipped": { "slug": "...", "name": "...", "value": 84021 },
      "concluded":    { ... },
      "longestStreak":{ ... },
      "languages":    { ... }
    }
  }
  ```
  Entries: all listed passports ordered by `verified_score` DESC, ties broken
  by earlier `created_at`. Spotlight values come from the same aggregate pass
  over listed passports' sessions (acceptable at this scale; revisit caching
  when listed count × sessions makes it slow).
- Card payloads (`/api/passports/slug/:slug`, `/api/me`) gain
  `rank: number | null` and `listedCount: number` when the passport is listed
  (null rank when unlisted — UI omits the line).

## Score note

`verified_score` uses the existing `aggregate()` on the filtered row set —
no new formula. A passport with zero enclave-verified sessions lists with
score 0 (allowed; the empty-ladder problem is worse than a zero row).

## UI

- **`/leaderboard` page** (new route, linked from landing + card footer):
  spotlight row of four mini-cards (Lines Shipped / Sessions Concluded /
  Longest Streak / Most Languages — four different winners by design), then
  the ranked table: rank, name → `/p/:slug` link, grade seal (reuse
  `GradeSeal`), verified score, sessions, lines shipped, signed-blocks count.
  Trust-posture line under the header: "Ranked by enclave-attested sessions
  only. Signed-block counts are present-in-trace, not vendor-validated.
  Listing is opt-in." Empty state sells the toggle.
- **Dashboard**: a "List me on the leaderboard" toggle (Switch component,
  same card style), showing current rank once listed.
- **Public card + OG image**: when listed, a "#N of M on the leaderboard"
  line; OG image gains the same (og.ts already draws stat lines — one more).
  Not shown when unlisted — no leakage.

## Gaming / abuse notes

- Opt-in + enclave-only ranking (decided above).
- `signed_blocks` displayed but never ranked (a faker can stuff opaque blobs;
  we refuse to reward the number, only show it).
- Rank recomputation is read-time (ORDER BY over ≤ hundreds of rows);
  `verified_score` writes are upload-time — no cron, no drift beyond the 60s
  cache.
- Name collisions/impersonation on the ladder: names were always
  user-chosen and public on cards; the ladder doesn't change that. Punt on
  verified identity (existing product-wide limitation, documented on /about).

## Not building

Time-windowed ladders, followers/notifications, directory filters, replay
oracle, attestor enclave, pagination.

## Testing

- Worker: parser fixtures for `signedBlocks` both harnesses (blocks with and
  without the fields); verified_score recompute on upload/reprocess/delete
  (unit-test the recompute helper); leaderboard endpoint shape + ordering +
  tie-break; PATCH auth (wrong token 401, unlisted default).
- Rust: same fixtures, parity counts; e2e asserts signed_blocks in the signed
  payload.
- Web: build; manual pass on empty/1-entry/9-entry states.

## Rollout

1. Parsers + migration + endpoints + UI ship together (zeros degrade fine).
2. Enclave v0.4.3 deploy (standard dance); worker+web after. `signed_blocks`
   populates as sessions are uploaded/re-uploaded — leaderboard doesn't wait
   on it (column defaults 0, displayed as "—" when 0).
3. Existing listed=0 default means launch is silent until people toggle; seed
   by listing the owner's own passport and sharing the page.

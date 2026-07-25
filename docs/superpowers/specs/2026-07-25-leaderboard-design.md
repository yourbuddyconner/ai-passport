# Leaderboard, Team Ladders & Discovery — Design (amended)

**Date:** 2026-07-25 (amended same day after adversarial product review)
**Status:** Approved design, pre-implementation. Worker + web only — NO enclave changes.

## Goal

Close the growth loop: colleague-to-colleague card sharing becomes group
onboarding via private team ladders; a global leaderboard is the union view.
Opt-in listing, enclave-verified ranking, rank shown at the moment of pride.

Grounding at design time: 12 passports, 9 active (the owner's circle — the
launch asset).

## Decisions

- **Purpose:** growth loop. Primary surface = private/invite team ladders
  (the product's real distribution channel is an engineer showing
  colleagues); the global page is the union view.
- **Listing (global):** opt-in, default off. Joining a team ladder exposes
  you to that ladder's members only — it does NOT set the global flag.
- **Trust:** ranked by score over enclave-verified sessions ONLY. Positive
  framing on-page: "Every rank is backed by enclave-attested sessions."
  Fine print (what attestation does/doesn't prove) lives on /about, not
  under the page header.
- **CUT (user decision):** `signed_blocks` — we cannot verify vendor
  signatures (Fernet/symmetric), so we display nothing about them. No
  enclave deploy in this batch. (Revisit only if vendors ever publish
  verifiable receipts.)
- **Review amendments adopted:** small-N shielding, rank-if-listed preview,
  pride-moment prompt, page OG images, two spotlights with distinct winners,
  zero-row gate, join-friction copy.

## Data model

```sql
ALTER TABLE passports ADD COLUMN listed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE passports ADD COLUMN verified_score INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS ladders (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,          -- public URL path /l/:slug
  invite_code TEXT UNIQUE NOT NULL,   -- unguessable join token
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
```

- `verified_score`: denormalized; recomputed in the sessions POST
  (upload/reprocess), session DELETE, and on PATCH listed=true. Aggregate
  over `verification='enclave'` rows only; store `Math.round(score)`.
- Ladder slugs: generated like passport slugs. `invite_code`: 128-bit
  random hex. Viewing a ladder page requires only the slug; JOINING requires
  the invite code (share link = `/l/:slug?join=<code>`).

## API

- `PATCH /api/passports/:id` `{listed: boolean}` — edit-token/passkey auth;
  recomputes verified_score on transition to true.
- `POST /api/ladders` `{name}` (auth'd passport) → `{id, slug, inviteCode}`;
  creator auto-joins. Limit: a passport may create ≤ 5 ladders.
- `POST /api/ladders/:slug/join` `{inviteCode}` (auth'd passport) → joins.
  `DELETE /api/ladders/:slug/membership` → leave. Creator leaving does not
  delete the ladder; last member leaving does.
- `GET /api/ladders/:slug` (public): `{name, total, entries[]}` — members
  with ≥1 enclave-verified session, ranked by verified_score, ties by
  earlier created_at. Members with 0 verified sessions are listed in a
  separate `pending` count, not as rows.
- `GET /api/leaderboard` (public, Cache-Control 60s): globally-listed
  passports (same gating: ≥1 enclave-verified session to appear), entries as
  ladder shape, plus `spotlights`: exactly TWO at launch (Lines Shipped,
  Sessions Concluded), winners enforced-distinct (a slug may win at most one;
  next-best takes the second). Expand to four spotlights only when
  total ≥ 15.
- Card payloads gain, when applicable: `globalRank/listedCount` (only if
  listed) and `ladders: [{slug, name, rank, size}]` (only the caller's own
  via /api/me; public card shows ladder ranks only if the passport is a
  member AND the ladder page is where the viewer came from — simpler: public
  card shows globalRank only, ladder ranks live on ladder pages).

## Rank display rules (small-N shielding)

- Card + OG "#N of M" line renders ONLY when `listedCount >= 25`. Below
  that, cards/OG are unchanged from today (no leakage of tiny N).
- Team-ladder ranks are exempt from the floor — "#2 on Team Acme" is a
  chosen group and reads as complete at any size. Shown on ladder pages
  (and share text from ladder pages), not on the global card OG.
- shareText updates follow the same rules as OG.

## The listing/joining moments (conversion mechanics)

- **Rank-if-listed preview:** the dashboard shows unlisted users their
  would-be global rank, computed privately ("You'd be #4 of 9"). One query,
  no exposure.
- **Pride-moment prompt:** after a batch upload completes with ≥1 accepted
  non-duplicate session, show a one-time inline prompt with the concrete
  number: "You'd be #3 of 9 on the leaderboard — list your passport?"
  [List me] [Not now]. Dismissal persists (localStorage) — never nag.
- Settings toggle remains the system of record.

## UI

- **/leaderboard**: trust headline ("Every rank is backed by
  enclave-attested sessions"), two spotlight mini-cards, ranked table
  (rank, name → card, grade seal, verified score, sessions, lines shipped).
  Empty/thin state: "Start a ladder with your team" CTA + a copy-paste
  one-liner for finding trace files (join-friction reduction:
  `ls ~/.claude/projects/*/*.jsonl ~/.codex/sessions/*/*/*/*.jsonl`).
- **/l/:slug** (ladder page): same table component scoped to members, ladder
  name, member count, "Join this ladder" (with code) / "Invite" (copies
  link with code, member-only). 
- **Dashboard**: rank preview, listed toggle, "Your ladders" section with
  create + invite-link copy.
- **OG images**: og.ts gains a leaderboard/ladder variant — podium top-3
  (grade seals + names + scores) in the existing card visual language. The
  PAGE is the shareable artifact at launch, not individual cards.

## Rollout

0. **Pre-seed (founder work, before announcing):** personally ask the 9
   active passport holders to toggle listed and/or create the first team
   ladder; page must be born with ≥7 rows.
1. Migration + endpoints + UI ship together (worker+web only, one deploy).
2. Owner creates the first ladder, shares invite links.
3. Announce with the /leaderboard OG.

## Not building

signed_blocks (cut), time-windowed ladders, followers/notifications,
directory filters, replay oracle, pagination, ladder admin roles
(creator == just a member who made it), four spotlights (until N ≥ 15).

## Testing

- Worker: verified_score recompute paths (upload/reprocess/delete/list);
  leaderboard + ladder endpoint shapes, ordering, tie-break, zero-row
  gating, distinct-winner spotlights; ladder create/join/leave auth (wrong
  invite code 403, join twice idempotent, last-leaver deletes, 5-ladder
  cap); PATCH auth; small-N: card payload omits rank when listedCount < 25.
- Web: build; manual pass on empty ladder, 1-member ladder, thin global
  page, rank-preview + prompt flow.

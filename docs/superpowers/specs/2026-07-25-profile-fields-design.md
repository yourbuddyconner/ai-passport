# Profile Fields (LinkedIn / Twitter / Company) — Design

**Date:** 2026-07-25
**Status:** Approved design, pre-implementation. Worker + web only.

## Goal

Optional self-claimed profile fields on passports — LinkedIn, Twitter/X,
current company — shown on the public card and on leaderboard/ladder rows,
turning the ladder into a browsable talent surface.

## Data model

```sql
-- worker/migrations/0007_profile.sql
ALTER TABLE passports ADD COLUMN linkedin TEXT;
ALTER TABLE passports ADD COLUMN twitter TEXT;
ALTER TABLE passports ADD COLUMN company TEXT;
```

Stored values are NORMALIZED HANDLES, never URLs:
- `linkedin`: the /in/ slug only; normalization strips any of
  `https://`, `http://`, `www.`, `linkedin.com/in/`, leading/trailing `/`;
  valid charset `^[A-Za-z0-9\-]{3,100}$` else 400.
- `twitter`: bare handle; strips URL prefixes (`x.com/`, `twitter.com/`) and
  leading `@`; valid `^[A-Za-z0-9_]{1,15}$` else 400.
- `company`: free text, trimmed, 1-64 chars.
- Empty string or null in the PATCH clears the field (stored as NULL).

Links are CONSTRUCTED, never echoed: `https://www.linkedin.com/in/{slug}`,
`https://x.com/{handle}`. User input can never become an arbitrary href.
Normalization + validation implemented once in a shared worker module and
mirrored client-side for instant feedback; server is authoritative.

## API

- `PATCH /api/passports/:id` (existing, auth'd) additionally accepts
  `{linkedin?, twitter?, company?}` — each optional, null/'' clears,
  invalid → 400 `{error}` naming the field.
- Payload additions (all nullable): `/api/me.passport`, card payloads
  (`/api/passports/slug/:slug`), and leaderboard + ladder `entries[]` gain
  `linkedin`, `twitter`, `company` (normalized handles).

## UI

- Dashboard: "Profile" card — three labeled inputs (placeholders show the
  accepted form, e.g. "linkedin.com/in/your-slug or just the slug"), one
  Save button, server errors shown verbatim, saved-state flash.
- Public card (`Passport.tsx`): company as muted text under the name;
  LinkedIn/X icon links beside it (constructed hrefs,
  `rel="noopener noreferrer" target="_blank"`).
- `RankTable.tsx`: company text under/beside the name + the two icon links
  when present.
- NOT in OG images (unattested claims stay off the attested-stats artwork).

## Honesty posture

Self-claimed and unverified, same trust level as the name field. No badge,
no verification implication. /about's identity-limitations paragraph covers
it when that ships.

## Not building

OAuth account verification, per-share visibility, company autocomplete,
GitHub field (add later if asked).

## Testing

- Worker: normalization table-driven tests (full URL, www, bare slug, @handle,
  uppercase, trailing slash, too-long, illegal chars, empty-clears);
  PATCH validation 400s; payload presence in card/leaderboard/ladder shapes.
- Web: build; manual check of card/table rendering with and without fields.

## Rollout

Migration 0007 → deploy worker+web (same ordering rule as 0005/0006 —
documented in README). Columns nullable; existing rows unaffected.

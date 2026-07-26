# CLI Upload (One-Liner + Rotating Token) — Design

**Date:** 2026-07-25
**Status:** Approved design, pre-implementation. Worker + web only.

## Goal

A copy-paste terminal one-liner that uploads every local trace:

```
curl -fsSL "https://aipassport.dev/upload.sh?token=<32hex>" | sh
```

backed by a per-passport, upload-only token that auto-mints on dashboard
load, lives 15 minutes, and is reused (not rotated) across reloads until it
expires.

## Token model

```sql
-- worker/migrations/0008_upload_tokens.sql
CREATE TABLE IF NOT EXISTS upload_tokens (
  passport_id TEXT PRIMARY KEY REFERENCES passports(id),
  token TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL
);
```

- Minted inside `/api/me`: if no row or `expires_at <= now`, generate 32
  lowercase hex chars from `crypto.getRandomValues(new Uint8Array(16))`,
  UPSERT with `expires_at = now + 15min`. `/api/me` returns `uploadToken`
  and `uploadTokenExpiresAt`.
- **Upload-only scope:** the token authorizes exactly one action — POST
  sessions for its own passport, via `?token=` query param on
  `POST /api/passports/:id/sessions` (checked when x-edit-token and cookie
  auth are absent; token must match the passport AND be unexpired).
  It is NEVER accepted by PATCH, DELETE, ladder routes, or anything else.
- Expired/wrong token → 403 `{error: 'upload token invalid or expired —
  reload your dashboard for a fresh command'}`.

## The served script

`GET /upload.sh?token=<t>` → `text/x-shellscript`, `Cache-Control: no-store`.
The worker templates the token and passport id (resolved from the token; 404
if unknown — an expired-but-known token still serves the script since
validation happens at upload). POSIX sh, no bashisms:

- Globs `~/.claude/projects/*/*.jsonl` and
  `~/.codex/sessions/*/*/*/rollout-*.jsonl`.
- Per file: skip >25MB (`wc -c`) with a "skipped (too large — upload via
  browser)" line; POST `--data-binary @file` as text/plain with the token;
  print `uploaded` / `duplicate — skipped` / server error text by grepping
  the JSON response minimally.
- Summary: counts uploaded/duplicate/skipped/failed + the card URL
  (`https://aipassport.dev/p/<slug>`).
- The script is versioned in the repo (worker asset or inline template
  string) — auditable at the URL.

## Dashboard UI

"Upload from your terminal" card: the full command in a copyable code block,
a live countdown ("token valid 12:40 — reload for a fresh one" after
expiry), and the honesty line: "CLI uploads are TLS-protected but not
end-to-end encrypted — the browser uploader keeps traces sealed even from
our server."

## Security notes

- 15-min upload-only token in a URL is acceptable: worst case an attacker
  who captures it can add sessions to the victim's own passport for a few
  minutes (no reads, no destructive ops). Session quota (1000) bounds spam.
- Token comparison against the stored value; single active token per
  passport (UPSERT replaces).
- The plaintext-path privacy tradeoff is disclosed in the UI (above).

## Not building

Long-lived API keys, scopes beyond upload, E2E encryption from the CLI,
Windows PowerShell variant (POSIX only for now), upload progress bars.

## Testing

- Worker: mint/reuse/expiry logic (pure helpers + time injection);
  token-auth acceptance on sessions POST and REJECTION on PATCH/delete/
  ladder routes (the negative tests are the important ones); script
  endpoint templates the right token/slug and sets no-store.
- Manual: run the one-liner against production with a real token; verify
  mixed results (uploaded/duplicate/too-large) render sensibly.

## Rollout

Migration 0008 → deploy worker+web. No enclave changes.

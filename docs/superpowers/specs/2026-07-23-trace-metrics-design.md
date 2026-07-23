# Trace Metrics v2: LOC, Languages, Command Taxonomy — Design

**Date:** 2026-07-23
**Status:** Approved design, pre-implementation

## Goal

Extract three new metric families from session traces — lines of code
added/removed, language mix, and a Bash command taxonomy — and surface them on
the public card, in a rebalanced long-horizon fluency score, and in new
achievements. No new data collection: everything comes from fields already
present in Claude Code and Codex traces.

## Non-goals

- Steering/friction signals (interruptions, denials, error rates) — batch two.
- Private per-session analytics view — future work.
- Reprocessing existing stored ciphertext from R2 — old sessions backfill via
  re-upload only (dedupe already reprocesses on re-upload).

## Data model

`SessionStats` gains four fields, mirrored exactly in the TS parsers
(`worker/src/parsers/`) and Rust enclave parsers
(`verifier/crates/passport-verifier/src/parsers/`):

```ts
locAdded: number                      // lines added across Write/Edit/apply_patch
locRemoved: number                    // lines removed
languages: Record<string, number>    // normalized extension → lines touched
commandCounts: Record<string, number> // taxonomy category → count
```

### Extraction: Claude Code

- **Edit** results: `toolUseResult.structuredPatch` is a list of unified-diff
  hunks; count lines prefixed `+` as added, `-` as removed.
- **Write** results: `toolUseResult.type == "create" | "update"`; for `create`,
  count lines of `content` as added; for `update`, use `structuredPatch`.
- Sessions lacking `toolUseResult` fields (older harness versions, stripped
  traces) produce zeros — never a parse error.
- **Bash** `tool_use` inputs: classify `input.command`.

### Extraction: Codex

- **apply_patch** calls: the input is a literal `*** Begin Patch` body. Count
  payload lines starting `+`/`-` (excluding `***` markers); take file paths
  from `*** Update File:` / `*** Add File:` / `*** Delete File:` lines.
- **exec_command** calls: classify the `cmd` argument.

### Language normalization

Key = lowercase file extension with a small alias map applied identically in
both parsers: `tsx→ts`, `jsx→js`, `mjs→js`, `cjs→js`, `pyi→py`. Unknown
extensions keep their literal value; extensionless files bucket as `other`.
Value = lines touched (added + removed) in files with that extension.
Extension → display name ("ts" → "TypeScript") lives only in the web layer.

LOC counts **all** file types, including `.md`/`.sql`/`.json` — the language
mix makes the composition visible, so nothing hides.

### Command taxonomy

First-token plus pattern match over the command string; compound commands
(`a && b`) classify by the first command only. Identical rule set (same
regexes, same order, first match wins) in TS and Rust:

| Category | Matches |
|---|---|
| `git` | `git …` |
| `test` | vitest, jest, pytest, `cargo test`, `go test`, `npm test` |
| `build` | `npm run build`, `cargo build`, make, tsc, vite build |
| `package` | npm/pnpm/yarn install/add, pip, `cargo add`, brew |
| `search` | grep, rg, find, fd, ag |
| `file` | ls, cat, mkdir, cp, mv, rm, touch, head, tail |
| `network` | curl, wget, gh, ssh |
| `run` | node, python, npx, `cargo run`, `npm run` (non-build) |
| `other` | everything else |

## Privacy

Same posture as `projectHash`: raw file paths and raw command strings never
leave the enclave (or the in-process fallback parser). Only normalized
extension totals and category counts are emitted, signed, and stored. No new
ciphertext, no new PII surface.

## Schema

One migration on `sessions`:

```sql
ALTER TABLE sessions ADD COLUMN loc_added INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN loc_removed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN languages TEXT NOT NULL DEFAULT '{}';
ALTER TABLE sessions ADD COLUMN command_counts TEXT NOT NULL DEFAULT '{}';
```

`languages` and `command_counts` are open maps (like `tool_counts`), so new
extensions/categories flow through without further migrations. Existing rows
default to zeros; users backfill by re-uploading traces.

## Score v2 (long-horizon)

Design principle: no dimension should max out in week one. Log curves with
ceilings sized for years of heavy use; every formula shown on the card.
All contributions clamp to `[0, max]`.

| Dimension | Max | Formula | Floor → ceiling |
|---|---|---|---|
| volume | 20 | `20 × log10(sessions) / 4` | 1 → 10,000 sessions |
| codeShipped | 20 | `20 × (log10(locAdded) − 2) / 5` | 100 → 10M lines |
| toolBreadth | 20 | `distinctTools × 2` (linear) | 0 → 10 tools |
| output | 15 | `15 × (log10(outputTokens) − 5) / 6` | 100k → 100B tokens |
| consistency | 15 | `15 × log10(activeDays) / 3` | 1 → 1,000 days |
| multiHarness | 10 | binary: 2+ harnesses | — |

Grade thresholds unchanged (AI-Native 80 / Power User 55 / Practitioner 30).
Under these curves a solid current user lands mid-50s; AI-Native means years.

When `codeShipped` is 0 but sessions exist, the card shows a hint:
"re-upload sessions to count lines shipped."

## Achievements (new; existing ones unchanged)

Same `tiered()` pattern in `worker/src/score.ts`:

- **Polyglot** — 5 distinct languages with ≥100 lines each
- **Ten Thousand Lines** — 10,000 LOC added across sessions
- **Refactorer** — 5,000 LOC removed
- **Git Native** — 250 git commands
- **Test Runner** — 100 test commands

## Card UI (`/p/:slug`)

- **Language bar**: one horizontal stacked bar, top 5 languages + "other",
  display names mapped in the web layer.
- **Lines shipped**: +added / −removed stat pair in the existing stats grid.
- **Command mix**: compact one-line row under top tools
  (e.g. "git ×410 · test ×120 · build ×85").

No new pages, no charting library.

## Testing

- **Worker (vitest)**: fixtures with real-shaped Claude Code lines
  (`structuredPatch`, `create` results, Bash tool_use) and a Codex trace with
  an `apply_patch` body; assert exact LOC / language / command counts. Score
  tests updated for the v2 breakdown, including log-curve edge cases (0
  sessions, exactly-at-floor, above-ceiling).
- **Rust (enclave)**: parser unit tests using the same fixture content,
  asserting numbers identical to the TS tests — parity is the requirement.
- **E2e**: extend `verifier/crates/e2e` to assert the new fields appear in the
  signed `/analyze` response.

## Rollout

1. Ship parsers + schema + score together (score reads zeros gracefully).
2. Existing passports re-grade under score v2 immediately; new dimensions fill
   in as users re-upload.
3. Enclave redeploy bumps the app version; worker falls back to in-process
   parsing (format-verified) as today if the verifier is unreachable.

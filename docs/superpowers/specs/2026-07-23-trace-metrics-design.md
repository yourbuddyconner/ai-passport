# Trace Metrics v2: LOC, Languages, Commands, Behavior — Design

**Date:** 2026-07-23
**Status:** Approved design, pre-implementation. Calibrated against 33 real
local sessions (prototype run 2026-07-23).

## Goal

Extract new metric families from session traces — lines of code, language mix,
a shell-command taxonomy, and structural behavior signals (outcomes, autonomy,
delegation) — and surface them on the public card, in a rebalanced
long-horizon fluency score, and in new achievements. No new data collection:
everything comes from fields already present in Claude Code and Codex traces.

Design lens: the card is consumed by a skeptical third party (e.g. a hiring
manager) in ~15 seconds. It should answer three questions: **how much** they
use AI, **how well** (verified outcomes), and **how** (working style). Metrics
must resist casual inflation; see Gaming resistance below.

## Non-goals

- Prompt-content analysis (needs the deep-analysis LLM — separate branch).
- Interrupt/denial steering signals — batch two.
- Churn ratio (same-session rewrite fraction) — computable from
  structuredPatch overlap, measured at 14.8% on real data, but no card
  surface justifies the parity cost yet. Future batch.
- Reprocessing stored ciphertext from R2 — old sessions backfill via
  re-upload only (dedupe already reprocesses on re-upload).

## Data model

`SessionStats` gains these fields, mirrored exactly in the TS parsers
(`worker/src/parsers/`) and Rust enclave parsers
(`verifier/crates/passport-verifier/src/parsers/`):

```ts
locAdded: number                      // lines added (Write/Edit/apply_patch), post-exclusion
locRemoved: number                    // lines removed, post-exclusion
languages: Record<string, number>    // normalized extension → lines touched
commandCounts: Record<string, number> // taxonomy category → count
humanTurns: number                    // real human prompts (see filtering)
agenticity: number                    // MEDIAN tool calls per human turn
longestRun: number                    // max consecutive tool calls between human inputs
parallelBatches: number               // tool batches with 2+ parallel tool_use
delegationCalls: number               // Agent/Task/Workflow tool calls
verifiedEditCycles: number            // edit→(test|build) success sequences
landed: boolean                       // session ended with tested, committed work
```

### Human-turn filtering (critical for agenticity)

Most `user` lines are not humans. A human prompt is a `user` line that is not
`isSidechain`, not `isMeta`, and whose `message.content` is either a string
not starting with `<` or `{`, or a block array containing `text` blocks and no
`tool_result` blocks. Codex: `user_message` event payloads are explicitly
typed. (Same rule the deep-analysis excerpt builder uses.)

### Extraction: Claude Code

- **Edit results**: `toolUseResult.structuredPatch` hunks; `+` lines added,
  `-` removed.
- **Write results**: `toolUseResult.type == "create"` → count `content`
  lines as added; `"update"` → use `structuredPatch`.
- **Bash inputs**: classify `input.command` (taxonomy below); map
  `tool_use.id → command` so the paired `tool_result` (`is_error`) gives
  success/failure for outcome detection.
- **Parallel batches**: assistant lines each carry one content block; parallel
  calls share a `requestId`. Group tool_use by `requestId`; batches with ≥2
  count as parallel.
- **Delegation**: tool_use names `Agent`, `Task`, `Workflow`. (Sidechain
  transcripts live in separate files and are NOT counted — prototype
  confirmed `isSidechain` never appears in the main session file.)
- Sessions lacking any of these fields produce zeros, never parse errors.

### Extraction: Codex

- **apply_patch**: literal `*** Begin Patch` body; count `+`/`-` payload lines
  (excluding `***` markers); paths from `*** Update/Add/Delete File:` lines.
- **exec_command**: classify `cmd`; success from the paired
  `function_call_output`.
- Human turns from `user_message` events; tool calls from
  `function_call`/`custom_tool_call` events.

### LOC exclusions (gaming guard)

Files matching generated/vendored patterns count toward nothing:
`package-lock.json`, `Cargo.lock`, `pnpm-lock.yaml`, `yarn.lock`,
`*.min.js|css`, and any path containing `/node_modules/`, `/dist/`,
`/target/`, `/build/`. Identical regex in both parsers.

### Language normalization

Key = lowercase extension, alias map `tsx→ts, jsx→js, mjs→js, cjs→js, pyi→py`;
unknown extensions keep their literal value; extensionless → `other`.
Value = lines touched (added + removed). Extension → display name lives only
in the web layer.

### Command taxonomy (v2 — validated against real data)

Naive first-token matching classified 59% of real commands as `other`
(ubiquitous `cd X && …` and `VAR=… cmd` prefixes); this design got that to
23% with 7.2% test share on real traces.

1. **De-prefix**: split on `&&`/`;`, drop leading segments matching
   `cd|export|source|nvm|conda|VAR=value`.
2. **Precedence match** against the full remaining command, first match wins.
   Order and patterns (identical regexes in TS and Rust):

| Category | Matches (within full command) |
|---|---|
| `test` | vitest, jest, pytest, playwright, nextest, `(cargo\|go\|npm\|pnpm\|yarn\|bun\|make) test` |
| `build` | `(npm\|pnpm\|yarn\|bun) run build`, `cargo build`, tsc, `vite build`, make, `docker build` |
| `package` | `(npm\|pnpm\|yarn\|bun) (install\|add\|i)`, `pip install`, `cargo add`, `brew install` |
| `git` | `git …` anywhere |
| `search` | leading grep, rg, find, fd, ag |
| `network` | leading curl, wget, gh, ssh |
| `ops` | leading kubectl, docker, terraform, wrangler, aws, gcloud, flyctl |
| `run` | leading node, python, npx, bash, `cargo run`, `(npm\|pnpm) run`, `./…` |
| `file` | leading ls, cat, mkdir, cp, mv, rm, touch, head, tail, wc, sed, awk, echo, printf, chmod, sqlite3, jq |
| `other` | everything else |

Precedence means `cd worker && npx vitest run` → `test`, and
`pnpm install` → `package` while `pnpm test` → `test`.

### Outcome definitions (calibrated)

- **Verified-edit cycle**: an edit occurs (dirty flag set), then a `test` or
  `build` command succeeds (`is_error` false) → one cycle, flag clears.
  Real data: median 2/session, p75 12.
- **Landed session**: `edits > 0` AND a successful `git commit` occurs after
  the last edit AND at least one successful test/build occurred after editing
  began. Commit detection: successful git command matching `\bcommit\b`.
  Calibration: strict ordering (commit>green>last edit) matched only 2/29
  real edit-sessions; any-commit matched 23/29; this definition matched
  15/29 (~52%) — discriminating and accurate.

## Gaming resistance

Users choose which sessions to upload, so **rates are curation-vulnerable**
(upload only good sessions → inflated ratio) while **counts are
curation-resistant** (uploading more can only increase them). Therefore:
score and achievements consume only counts and maxes; ratios appear
display-only with their denominator visible ("41 of 56 sessions landed").

Agenticity is a *style* axis, not a virtue axis (high = autonomous, low can
be expert precision-steering) — display-only, never scored. Delegation,
landed sessions, and verified cycles are scored: they require actually doing
the work to inflate.

Honest floor (documented on /about): a determined user can forge an entire
JSONL trace. Format verification catches sloppiness, not determination; these
metrics resist casual inflation. Forgery resistance is future
harness-attestation work.

## Score v2 (long-horizon, behavior-weighted)

No dimension maxes out in week one; log curves sized for years. All clamp to
`[0, max]`; formulas shown on the card.

| Dimension | Max | Formula | Floor → ceiling |
|---|---|---|---|
| volume | 15 | `15 × log10(sessions) / 4` | 1 → 10,000 sessions |
| codeShipped | 15 | `15 × (log10(locAdded) − 2) / 5` | 100 → 10M lines |
| landed | 15 | `15 × log10(landedSessions + 1) / 3` | 0 → 1,000 landed |
| output | 10 | `10 × (log10(outputTokens) − 5) / 6` | 100k → 100B tokens |
| verifiedCycles | 10 | `10 × log10(cycles) / 4` | 1 → 10,000 cycles |
| delegation | 10 | `10 × log10(delegationCalls) / 3` | 1 → 1,000 calls |
| toolBreadth | 10 | `distinctTools × 1` (linear) | 0 → 10 tools |
| consistency | 10 | `10 × log10(activeDays) / 3` | 1 → 1,000 days |
| multiHarness | 5 | binary: 2+ harnesses | — |

Grade thresholds unchanged (AI-Native 80 / Power User 55 / Practitioner 30).
Sanity check against the prototype data (33 sessions, 79k LOC, 15 landed,
347 cycles, 858 delegation calls, 2 harnesses): ≈60 → Power User. AI-Native
requires years of heavy, verified use.

When behavior dimensions are 0 but sessions exist, the card hints:
"re-upload sessions to count landed work."

## Achievements

New (same `tiered()` pattern; existing ones unchanged):

- **Polyglot** — 5 distinct languages with ≥100 lines each
- **Ten Thousand Lines** — 10,000 LOC added
- **Git Native** — 250 git commands
- **Test Runner** — 100 test commands
- **Full Auto** — a 100+ tool-call autonomous run (real-data max: 207)
- **Lander** — 25 landed sessions

(Refactorer — LOC removed — was cut: trivially gameable, zero consumer
signal.)

## Card UI (`/p/:slug`)

- **Language bar**: one horizontal stacked bar, top 5 + "other", display
  names in the web layer.
- **Landed work** (headline of the new stats): "N sessions landed — tested &
  committed", with verified-cycle count alongside.
- **Working style row**: agenticity ("median N tool calls per prompt"),
  longest autonomous run, delegation count.
- **Command mix**: percentages, not raw counts, with **test share** called
  out as a named stat ("test commands: 7% of shell use").
- **Lines shipped**: secondary stat (+added / −removed) under the language
  bar — deliberately not a headline; LOC is a discredited metric to exactly
  the audience this card targets.

No new pages, no charting library.

## Schema

One migration on `sessions`, mirroring the `tool_counts` pattern; open maps
need no future migrations for new categories:

```sql
ALTER TABLE sessions ADD COLUMN loc_added INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN loc_removed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN languages TEXT NOT NULL DEFAULT '{}';
ALTER TABLE sessions ADD COLUMN command_counts TEXT NOT NULL DEFAULT '{}';
ALTER TABLE sessions ADD COLUMN human_turns INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN agenticity REAL NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN longest_run INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN parallel_batches INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN delegation_calls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN verified_edit_cycles INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN landed INTEGER NOT NULL DEFAULT 0;
```

## Privacy

Same posture as `projectHash`: raw file paths, raw command strings, and
prompt text never leave the enclave (or the in-process fallback parser). Only
normalized extension totals, category counts, and behavior counts are
emitted, signed, and stored.

## Testing

- **Worker (vitest)**: fixtures with real-shaped Claude Code lines
  (structuredPatch, create results, Bash tool_use + paired tool_result with
  is_error, requestId-grouped parallel calls, isMeta noise lines) and a Codex
  trace with apply_patch + exec_command; assert exact values for every new
  field. Taxonomy tests must cover `cd X && npx vitest run` → test,
  `pnpm install` → package, `pnpm test` → test, `VAR=1 make` → build.
  Landed/cycle tests cover: edit→green→commit (landed), edit→commit without
  green (not landed), green before any edit (not a cycle).
- **Rust (enclave)**: same fixture content, asserting numbers identical to
  the TS tests — parity is the requirement.
- **Score**: log-curve edge cases (zero, at-floor, above-ceiling) per
  dimension; grade boundary tests.
- **E2e**: extend `verifier/crates/e2e` to assert new fields in the signed
  `/analyze` response.

## Rollout

1. Ship parsers + schema + score v2 together (score reads zeros gracefully).
2. Existing passports re-grade immediately; behavior/code dimensions fill in
   as users re-upload (dedupe reprocesses).
3. Enclave redeploy bumps the app version; worker falls back to in-process
   parsing (format-verified) as today if the verifier is unreachable.
4. `/about` gains a paragraph on what verification does and does not prove
   (format + consistency now; identity binding and harness attestation are
   future work).

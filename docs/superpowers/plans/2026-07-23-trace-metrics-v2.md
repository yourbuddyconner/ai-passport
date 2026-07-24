# Trace Metrics v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract LOC, language mix, command taxonomy, and behavior metrics (outcomes, agenticity, delegation, red→green cycles, skills/MCP, background tasks) from traces; persist them; rebalance the score; render them on the card.

**Architecture:** A shared heuristics module (TS + line-for-line Rust port) holds the command taxonomy, path/extension rules, and outcome state machine. Both harness parsers feed it events. New columns on `sessions` follow the `tool_counts` JSON-text pattern. `score.ts` aggregates, computes score v2 (log curves), achievements, and session concurrency. The card gains a language bar, outcome bar, and working-style row.

**Tech Stack:** TypeScript (Hono worker, vitest), Rust (enclave, `regex` crate), React + Tailwind (web), D1/SQLite.

**Spec:** `docs/superpowers/specs/2026-07-23-trace-metrics-design.md` — read it first; it defines every metric, the outcome taxonomy, score formulas, and gaming-resistance rules.

## Global Constraints

- TS and Rust parsers MUST produce identical numbers for identical input — shared fixture content, asserted in both test suites.
- Raw file paths, raw command strings, and prompt text never leave the parser — only normalized extensions, category counts, skill/MCP names, and numeric counts.
- LOC exclusion regex (both languages): `package-lock\.json|Cargo\.lock|pnpm-lock\.yaml|yarn\.lock|\.min\.(js|css)$|/node_modules/|/dist/|/target/|/build/`
- Extension aliases: `tsx→ts, jsx→js, mjs→js, cjs→js, pyi→py`; extensionless → `other`.
- Taxonomy precedence (first match wins): test, build, package, git, search, network, ops, run, file, other.
- Outcome enum values exactly: `shipped landed committed green red unverified research trivial`.
- Score dimensions sum to exactly 100; all contributions clamp to `[0, max]`.
- Median: sort ascending; odd n → middle; even n → mean of the two middles; empty → 0.
- Sessions missing any new trace field parse to zeros/empties — never a ParseError.
- Commit after each passing task. Run `cd worker && npx vitest run` before every commit that touches worker/; `cargo test -p passport-verifier` before every commit that touches verifier/.

---

### Task 1: TS heuristics module

**Files:**
- Create: `worker/src/parsers/heuristics.ts`
- Test: `worker/test/heuristics.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 2, 3):
  - `type CommandCategory = 'test'|'build'|'package'|'git'|'search'|'network'|'ops'|'run'|'file'|'other'`
  - `deprefix(cmd: string): string`
  - `classifyCommand(cmd: string): CommandCategory` (deprefixes internally)
  - `isVerify(cmd: string): boolean` — test or build (deprefixes internally)
  - `isCommit(cmd: string): boolean` — raw command
  - `isShip(cmd: string): boolean` — raw command
  - `isGeneratedPath(path: string): boolean`
  - `normalizeExt(path: string): string`
  - `median(values: number[]): number`
  - `interface OutcomeEvent { kind: 'edit'|'verify'|'commit'|'ship'; ok: boolean; seq: number }`
  - `computeOutcome(events: OutcomeEvent[], toolCallCount: number): string`

- [ ] **Step 1: Write the failing tests**

```ts
// worker/test/heuristics.test.ts
import { describe, expect, it } from 'vitest'
import {
  classifyCommand, computeOutcome, deprefix, isCommit, isGeneratedPath,
  isShip, isVerify, median, normalizeExt, type OutcomeEvent,
} from '../src/parsers/heuristics'

describe('deprefix', () => {
  it('strips cd/env/source prefixes', () => {
    expect(deprefix('cd worker && npx vitest run')).toBe('npx vitest run')
    expect(deprefix('ENVIRONMENT=dev && make deploy')).toBe('make deploy')
    expect(deprefix('export FOO=1; nvm use 22; pnpm test')).toBe('pnpm test')
    expect(deprefix('git status')).toBe('git status')
  })
})

describe('classifyCommand', () => {
  const cases: Array<[string, string]> = [
    ['cd worker && npx vitest run', 'test'],
    ['pnpm test', 'test'],
    ['cargo test -p passport-verifier', 'test'],
    ['pnpm install', 'package'],
    ['npm run build', 'build'],
    ['VAR=1 tsc --noEmit', 'build'],
    ['git commit -m "x"', 'git'],
    ['rg -n "foo" src/', 'search'],
    ['gh pr view 12', 'network'],
    ['npx wrangler deploy', 'ops'],
    ['kubectl get pods', 'ops'],
    ['python3 scripts/x.py', 'run'],
    ['cat file.txt', 'file'],
    ['sed -i "" "s/a/b/" f', 'file'],
    ['some-custom-binary --flag', 'other'],
  ]
  for (const [cmd, want] of cases) {
    it(`${cmd} → ${want}`, () => expect(classifyCommand(cmd)).toBe(want))
  }
})

describe('verify/commit/ship detection', () => {
  it('isVerify matches test and build', () => {
    expect(isVerify('cd worker && npx vitest run')).toBe(true)
    expect(isVerify('cargo build --release')).toBe(true)
    expect(isVerify('git status')).toBe(false)
  })
  it('isCommit', () => {
    expect(isCommit('git add -A && git commit -m "x"')).toBe(true)
    expect(isCommit('git status')).toBe(false)
  })
  it('isShip', () => {
    expect(isShip('git push origin main')).toBe(true)
    expect(isShip('gh pr create --fill')).toBe(true)
    expect(isShip('npx wrangler deploy')).toBe(true)
    expect(isShip('git commit -m x')).toBe(false)
  })
})

describe('paths', () => {
  it('isGeneratedPath', () => {
    expect(isGeneratedPath('/a/package-lock.json')).toBe(true)
    expect(isGeneratedPath('/a/node_modules/x/y.js')).toBe(true)
    expect(isGeneratedPath('/a/src/app.min.js')).toBe(true)
    expect(isGeneratedPath('/a/src/app.ts')).toBe(false)
  })
  it('normalizeExt', () => {
    expect(normalizeExt('/a/b/App.TSX')).toBe('ts')
    expect(normalizeExt('/a/b/mod.rs')).toBe('rs')
    expect(normalizeExt('/a/b/Makefile')).toBe('other')
  })
})

describe('median', () => {
  it('handles odd/even/empty', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([])).toBe(0)
  })
})

describe('computeOutcome', () => {
  const ev = (kind: OutcomeEvent['kind'], ok: boolean, seq: number): OutcomeEvent => ({ kind, ok, seq })
  it('no edits: research vs trivial by tool calls', () => {
    expect(computeOutcome([], 10)).toBe('research')
    expect(computeOutcome([], 9)).toBe('trivial')
  })
  it('shipped: ship after last edit', () =>
    expect(computeOutcome([ev('edit', true, 1), ev('ship', true, 2)], 5)).toBe('shipped'))
  it('landed: commit after last edit + green after first edit', () =>
    expect(computeOutcome([ev('edit', true, 1), ev('verify', true, 2), ev('commit', true, 3)], 5)).toBe('landed'))
  it('committed: commit after last edit, no verify ever', () =>
    expect(computeOutcome([ev('edit', true, 1), ev('commit', true, 2)], 5)).toBe('committed'))
  it('green: last post-edit verify ok, no commit', () =>
    expect(computeOutcome([ev('edit', true, 1), ev('verify', true, 2)], 5)).toBe('green'))
  it('red: last post-edit verify failed', () =>
    expect(computeOutcome([ev('edit', true, 1), ev('verify', true, 2), ev('edit', true, 3), ev('verify', false, 4)], 5)).toBe('red'))
  it('unverified: edits only', () =>
    expect(computeOutcome([ev('edit', true, 1)], 5)).toBe('unverified'))
  it('green before any edit does not count', () =>
    expect(computeOutcome([ev('verify', true, 1), ev('edit', true, 2)], 5)).toBe('unverified'))
  it('failed ship does not count', () =>
    expect(computeOutcome([ev('edit', true, 1), ev('ship', false, 2)], 5)).toBe('unverified'))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && npx vitest run test/heuristics.test.ts`
Expected: FAIL — cannot resolve `../src/parsers/heuristics`

- [ ] **Step 3: Implement**

```ts
// worker/src/parsers/heuristics.ts
// Shared trace heuristics: command taxonomy, path rules, outcome state machine.
// MUST stay line-for-line in sync with the Rust port in
// verifier/crates/passport-verifier/src/parsers/heuristics.rs.

export type CommandCategory =
  | 'test' | 'build' | 'package' | 'git' | 'search'
  | 'network' | 'ops' | 'run' | 'file' | 'other'

const PREFIX = /^\s*(cd\s|export\s|source\s|nvm\s|conda\s|\w+=\S*\s*$)/

const RULES: Array<[CommandCategory, RegExp]> = [
  ['test', /\b(vitest|jest|pytest|playwright|nextest|(cargo|go|npm|pnpm|yarn|bun|make) test)\b/],
  ['build', /\b((npm|pnpm|yarn|bun) run build|cargo build|tsc\b|vite build|make(\s|$)|docker build)\b/],
  ['package', /\b((npm|pnpm|yarn|bun) (install|add|i)\b|pip3? install|cargo add|brew install)/],
  ['git', /(^|\s)git\s/],
  ['search', /^\s*(grep|rg|find|fd|ag)\b/],
  ['network', /^\s*(curl|wget|gh|ssh)\b/],
  ['ops', /^\s*(kubectl|docker|terraform|wrangler|aws|gcloud|flyctl|npx wrangler)\b/],
  ['run', /^\s*(node|python3?|npx|bash|sh|cargo run|(npm|pnpm|yarn|bun) run|\.\/)/],
  ['file', /^\s*(ls|cat|mkdir|cp|mv|rm|touch|head|tail|wc|sed|awk|echo|printf|chmod|sqlite3|jq|diff|tar|unzip)\b/],
]

export function deprefix(cmd: string): string {
  const segs = cmd.split(/&&|;/)
  while (segs.length && PREFIX.test(segs[0].trim() + ' ')) segs.shift()
  const joined = segs.join('&&').trim()
  return joined || cmd
}

export function classifyCommand(cmd: string): CommandCategory {
  const c = deprefix(cmd)
  for (const [name, rx] of RULES) if (rx.test(c)) return name
  return 'other'
}

export function isVerify(cmd: string): boolean {
  const cat = classifyCommand(cmd)
  return cat === 'test' || cat === 'build'
}

export function isCommit(cmd: string): boolean {
  return /\bgit\b[^|;&]*\bcommit\b/.test(cmd)
}

export function isShip(cmd: string): boolean {
  return /\bgit push\b|\bgh pr create\b|\bwrangler (deploy|publish)\b|\bflyctl deploy\b/.test(cmd)
}

const GENERATED =
  /package-lock\.json|Cargo\.lock|pnpm-lock\.yaml|yarn\.lock|\.min\.(js|css)$|\/node_modules\/|\/dist\/|\/target\/|\/build\//

export function isGeneratedPath(path: string): boolean {
  return GENERATED.test(path)
}

const ALIASES: Record<string, string> = { tsx: 'ts', jsx: 'js', mjs: 'js', cjs: 'js', pyi: 'py' }

export function normalizeExt(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return 'other'
  const ext = base.slice(dot + 1).toLowerCase()
  return ALIASES[ext] ?? ext
}

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export interface OutcomeEvent {
  kind: 'edit' | 'verify' | 'commit' | 'ship'
  ok: boolean
  seq: number
}

/** Terminal-state classifier. Precedence per the spec's Outcome taxonomy. */
export function computeOutcome(events: OutcomeEvent[], toolCallCount: number): string {
  const edits = events.filter((e) => e.kind === 'edit')
  if (edits.length === 0) return toolCallCount >= 10 ? 'research' : 'trivial'
  const firstEdit = Math.min(...edits.map((e) => e.seq))
  const lastEdit = Math.max(...edits.map((e) => e.seq))
  if (events.some((e) => e.kind === 'ship' && e.ok && e.seq > lastEdit)) return 'shipped'
  const verifies = events.filter((e) => e.kind === 'verify')
  const greenAfterFirst = verifies.some((e) => e.ok && e.seq > firstEdit)
  const commitAfterLast = events.some((e) => e.kind === 'commit' && e.ok && e.seq > lastEdit)
  if (commitAfterLast && greenAfterFirst) return 'landed'
  if (commitAfterLast && verifies.length === 0) return 'committed'
  const postVerifies = verifies.filter((e) => e.seq > firstEdit)
  if (postVerifies.length > 0) {
    return postVerifies[postVerifies.length - 1].ok ? 'green' : 'red'
  }
  return 'unverified'
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && npx vitest run test/heuristics.test.ts`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add worker/src/parsers/heuristics.ts worker/test/heuristics.test.ts
git commit -m "feat(worker): shared trace heuristics — taxonomy, paths, outcome state machine"
```

---

### Task 2: Extend SessionStats and the Claude Code parser

**Files:**
- Modify: `worker/src/parsers/types.ts`
- Modify: `worker/src/parsers/claudeCode.ts` (full rewrite below)
- Test: `worker/test/parsers.test.ts` (append new describe block)

**Interfaces:**
- Consumes: everything from `heuristics.ts` (Task 1).
- Produces: `SessionStats` with the 15 new fields below; `parseClaudeCode(lines)` fills all of them. Tasks 3–6 rely on these exact names.

- [ ] **Step 1: Extend the type**

Append to `SessionStats` in `worker/src/parsers/types.ts` (after `projectHash`):

```ts
  locAdded: number
  locRemoved: number
  languages: Record<string, number>
  commandCounts: Record<string, number>
  humanTurns: number
  agenticity: number
  longestRun: number
  parallelBatches: number
  delegationCalls: number
  verifiedEditCycles: number
  redGreenCycles: number
  outcome: string
  skills: string[]
  mcpServers: string[]
  backgroundTasks: number
```

- [ ] **Step 2: Write the failing test**

Append to `worker/test/parsers.test.ts`:

```ts
describe('claude code v2 metrics', () => {
  const L = (o: object) => o
  const lines = [
    L({ type: 'user', sessionId: 's1', cwd: '/repo', timestamp: '2026-07-01T10:00:00Z',
        message: { content: 'add a feature' } }),
    // parallel batch: two tool_use sharing a requestId
    L({ type: 'assistant', sessionId: 's1', requestId: 'r1', timestamp: '2026-07-01T10:00:05Z',
        message: { model: 'claude-fable-5', usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/src/a.ts' } }] } }),
    L({ type: 'assistant', sessionId: 's1', requestId: 'r1',
        message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash',
          input: { command: 'cd worker && npx vitest run' } }] } }),
    // failing test result (red)
    L({ type: 'user', sessionId: 's1', message: { content: [
        { type: 'tool_result', tool_use_id: 't2', is_error: true }] } }),
    // edit via Write (create): 3 lines
    L({ type: 'assistant', sessionId: 's1', requestId: 'r2',
        message: { content: [{ type: 'tool_use', id: 't3', name: 'Write',
          input: { file_path: '/repo/src/a.ts', content: 'a\nb\nc' } }] } }),
    L({ type: 'user', sessionId: 's1', toolUseResult: { type: 'create', filePath: '/repo/src/a.ts',
        content: 'a\nb\nc', structuredPatch: [] },
        message: { content: [{ type: 'tool_result', tool_use_id: 't3' }] } }),
    // edit on generated path — excluded from LOC/languages
    L({ type: 'user', sessionId: 's1', toolUseResult: { type: 'create',
        filePath: '/repo/package-lock.json', content: 'x\n'.repeat(100), structuredPatch: [] },
        message: { content: [{ type: 'tool_result', tool_use_id: 't3b' }] } }),
    // Edit with structuredPatch: +2 -1 on a .tsx file (aliases to ts)
    L({ type: 'user', sessionId: 's1', toolUseResult: { filePath: '/repo/src/B.tsx',
        structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3,
          lines: [' keep', '+new1', '+new2', '-old'] }] },
        message: { content: [{ type: 'tool_result', tool_use_id: 't3c' }] } }),
    // passing test after edits (green + verified cycle + red→green cycle)
    L({ type: 'assistant', sessionId: 's1', requestId: 'r3',
        message: { content: [{ type: 'tool_use', id: 't4', name: 'Bash',
          input: { command: 'cd worker && npx vitest run', run_in_background: false } }] } }),
    L({ type: 'user', sessionId: 's1', message: { content: [
        { type: 'tool_result', tool_use_id: 't4', is_error: false }] } }),
    // commit then push → shipped
    L({ type: 'assistant', sessionId: 's1', requestId: 'r4',
        message: { content: [{ type: 'tool_use', id: 't5', name: 'Bash',
          input: { command: 'git add -A && git commit -m "feat"' } }] } }),
    L({ type: 'user', sessionId: 's1', message: { content: [
        { type: 'tool_result', tool_use_id: 't5' }] } }),
    L({ type: 'assistant', sessionId: 's1', requestId: 'r5',
        message: { content: [{ type: 'tool_use', id: 't6', name: 'Bash',
          input: { command: 'git push origin main', run_in_background: true } }] } }),
    L({ type: 'user', sessionId: 's1', message: { content: [
        { type: 'tool_result', tool_use_id: 't6' }] } }),
    // second human turn, then delegation + skill + mcp
    L({ type: 'user', sessionId: 's1', message: { content: 'now polish it' } }),
    L({ type: 'assistant', sessionId: 's1', requestId: 'r6',
        message: { content: [{ type: 'tool_use', id: 't7', name: 'Agent',
          input: { prompt: 'x', description: 'y' } }] } }),
    L({ type: 'assistant', sessionId: 's1', requestId: 'r7',
        message: { content: [{ type: 'tool_use', id: 't8', name: 'Skill',
          input: { skill: 'dataviz' } }] } }),
    L({ type: 'assistant', sessionId: 's1', requestId: 'r8', attributionMcpServer: 'claude-in-chrome',
        message: { content: [{ type: 'tool_use', id: 't9',
          name: 'mcp__claude-in-chrome__navigate', input: { url: 'x' } }] } }),
    // meta and sidechain lines must not count as human turns or main-chain calls
    L({ type: 'user', sessionId: 's1', isMeta: true, message: { content: 'injected' } }),
    L({ type: 'user', sessionId: 's1', message: { content: '<system-reminder>noise' } }),
    L({ type: 'assistant', sessionId: 's1', isSidechain: true,
        message: { content: [{ type: 'tool_use', id: 't10', name: 'Read', input: {} }] } }),
  ]

  it('extracts v2 metrics', () => {
    const s = parseClaudeCode(lines)
    expect(s.locAdded).toBe(5)            // 3 (create) + 2 (patch); lockfile excluded
    expect(s.locRemoved).toBe(1)
    expect(s.languages).toEqual({ ts: 6 }) // 3 + (2+1) on .ts/.tsx
    expect(s.commandCounts).toEqual({ test: 2, git: 2 })
    expect(s.humanTurns).toBe(2)
    expect(s.longestRun).toBe(6)          // t1..t6 before second human turn
    expect(s.agenticity).toBe(4.5)        // runs [6, 3] → median 4.5
    expect(s.parallelBatches).toBe(1)     // r1 has two tool_use
    expect(s.delegationCalls).toBe(1)
    expect(s.verifiedEditCycles).toBe(1)
    expect(s.redGreenCycles).toBe(1)      // fail t2 → edits → pass t4
    expect(s.outcome).toBe('shipped')
    expect(s.skills).toEqual(['dataviz'])
    expect(s.mcpServers).toEqual(['claude-in-chrome'])
    expect(s.backgroundTasks).toBe(1)     // t6 run_in_background
  })

  it('zeroes v2 metrics on minimal traces', () => {
    const s = parseClaudeCode([
      { type: 'user', sessionId: 's2', message: { content: 'hi' } },
      { type: 'assistant', sessionId: 's2', message: { model: 'claude-fable-5', content: [] } },
    ])
    expect(s.locAdded).toBe(0)
    expect(s.outcome).toBe('trivial')
    expect(s.skills).toEqual([])
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `cd worker && npx vitest run test/parsers.test.ts`
Expected: FAIL — new fields undefined / type errors

- [ ] **Step 4: Rewrite the parser**

Replace `worker/src/parsers/claudeCode.ts` entirely:

```ts
import {
  classifyCommand, computeOutcome, isCommit, isGeneratedPath, isShip,
  isVerify, median, normalizeExt, type OutcomeEvent,
} from './heuristics'
import { ParseError, type SessionStats } from './types'

interface ContentBlock {
  type?: string
  name?: string
  id?: string
  text?: string
  tool_use_id?: string
  is_error?: boolean
  input?: Record<string, unknown>
}

interface ClaudeLine {
  type?: string
  sessionId?: string
  cwd?: string
  timestamp?: string
  isMeta?: boolean
  isSidechain?: boolean
  requestId?: string
  attributionSkill?: string
  attributionMcpServer?: string
  toolUseResult?: {
    type?: string
    filePath?: string
    content?: string
    structuredPatch?: Array<{ lines?: string[] }>
  }
  message?: {
    model?: string
    usage?: { input_tokens?: number; output_tokens?: number }
    content?: ContentBlock[] | string
  }
}

export function looksLikeClaudeCode(firstLines: unknown[]): boolean {
  return firstLines.some(
    (o) =>
      typeof o === 'object' &&
      o !== null &&
      'sessionId' in o &&
      ['user', 'assistant', 'system', 'summary', 'file-history-snapshot'].includes(
        String((o as ClaudeLine).type),
      ),
  )
}

/** A human prompt: user line, not meta/sidechain, with real text content. */
function isHumanPrompt(o: ClaudeLine): boolean {
  if (o.type !== 'user' || o.isSidechain || o.isMeta) return false
  const c = o.message?.content
  if (typeof c === 'string') return !c.startsWith('<') && !c.startsWith('{')
  if (Array.isArray(c)) {
    const hasText = c.some((b) => b?.type === 'text')
    const hasToolResult = c.some((b) => b?.type === 'tool_result')
    return hasText && !hasToolResult
  }
  return false
}

export function parseClaudeCode(lines: unknown[]): SessionStats {
  const stats: SessionStats = {
    harness: 'claude-code',
    externalId: '',
    startedAt: null,
    endedAt: null,
    messageCount: 0,
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    models: [],
    toolCounts: {},
    locAdded: 0,
    locRemoved: 0,
    languages: {},
    commandCounts: {},
    humanTurns: 0,
    agenticity: 0,
    longestRun: 0,
    parallelBatches: 0,
    delegationCalls: 0,
    verifiedEditCycles: 0,
    redGreenCycles: 0,
    outcome: '',
    skills: [],
    mcpServers: [],
    backgroundTasks: 0,
  }
  const models = new Set<string>()
  const skills = new Set<string>()
  const mcpServers = new Set<string>()
  const requestCounts = new Map<string, number>()
  const bashCommands = new Map<string, string>() // tool_use id -> command
  const events: OutcomeEvent[] = []
  const runs: number[] = []
  let currentRun = 0
  let dirty = false // edits since last green verify (verified-edit cycle)
  let failed = false // a verify failed (red→green cycle)
  let editedSinceFail = false
  let seq = 0

  for (const raw of lines) {
    if (typeof raw !== 'object' || raw === null) continue
    const o = raw as ClaudeLine
    seq++
    if (!stats.externalId && o.sessionId) stats.externalId = o.sessionId
    if (!stats.cwd && o.cwd) stats.cwd = o.cwd
    if (o.timestamp) {
      if (!stats.startedAt || o.timestamp < stats.startedAt) stats.startedAt = o.timestamp
      if (!stats.endedAt || o.timestamp > stats.endedAt) stats.endedAt = o.timestamp
    }
    if (o.attributionSkill) skills.add(String(o.attributionSkill))
    if (o.attributionMcpServer) mcpServers.add(String(o.attributionMcpServer))
    if (o.isSidechain) continue
    if (o.type !== 'user' && o.type !== 'assistant') continue
    stats.messageCount++

    if (isHumanPrompt(o)) {
      stats.humanTurns++
      if (currentRun > 0) runs.push(currentRun)
      currentRun = 0
      continue
    }

    if (o.type === 'assistant' && o.message) {
      // Claude Code marks system-generated lines with model "<synthetic>".
      if (o.message.model && !o.message.model.startsWith('<')) models.add(o.message.model)
      const u = o.message.usage
      if (u) {
        stats.inputTokens += u.input_tokens ?? 0
        stats.outputTokens += u.output_tokens ?? 0
      }
      if (Array.isArray(o.message.content)) {
        for (const block of o.message.content) {
          if (block?.type !== 'tool_use' || !block.name) continue
          stats.toolCallCount++
          currentRun++
          stats.toolCounts[block.name] = (stats.toolCounts[block.name] ?? 0) + 1
          if (o.requestId) {
            requestCounts.set(o.requestId, (requestCounts.get(o.requestId) ?? 0) + 1)
          }
          const input = block.input ?? {}
          if (block.name === 'Agent' || block.name === 'Task' || block.name === 'Workflow') {
            stats.delegationCalls++
          }
          if (block.name === 'Skill' && typeof input.skill === 'string') skills.add(input.skill)
          if (block.name.startsWith('mcp__')) mcpServers.add(block.name.split('__')[1])
          if (block.name === 'Monitor' || (block.name === 'Bash' && input.run_in_background === true)) {
            stats.backgroundTasks++
          }
          if (block.name === 'Bash' && typeof input.command === 'string') {
            const cat = classifyCommand(input.command)
            stats.commandCounts[cat] = (stats.commandCounts[cat] ?? 0) + 1
            if (block.id) bashCommands.set(block.id, input.command)
          }
        }
      }
    }

    if (o.type === 'user') {
      const c = o.message?.content
      if (Array.isArray(c)) {
        for (const block of c) {
          if (block?.type !== 'tool_result' || !block.tool_use_id) continue
          const cmd = bashCommands.get(block.tool_use_id)
          if (cmd === undefined) continue
          bashCommands.delete(block.tool_use_id)
          const ok = block.is_error !== true
          if (isVerify(cmd)) {
            events.push({ kind: 'verify', ok, seq })
            if (ok) {
              if (dirty) {
                stats.verifiedEditCycles++
                dirty = false
              }
              if (failed && editedSinceFail) {
                stats.redGreenCycles++
                failed = false
              }
            } else {
              failed = true
              editedSinceFail = false
            }
          }
          if (ok && isCommit(cmd)) events.push({ kind: 'commit', ok: true, seq })
          if (isShip(cmd)) events.push({ kind: 'ship', ok, seq })
        }
      }
      const r = o.toolUseResult
      if (r && (Array.isArray(r.structuredPatch) || r.type === 'create')) {
        let add = 0
        let rem = 0
        if (r.type === 'create' && typeof r.content === 'string') {
          add = r.content.split('\n').length
        }
        if (Array.isArray(r.structuredPatch)) {
          for (const hunk of r.structuredPatch) {
            for (const l of hunk.lines ?? []) {
              if (l.startsWith('+')) add++
              else if (l.startsWith('-')) rem++
            }
          }
        }
        if (add > 0 || rem > 0) {
          events.push({ kind: 'edit', ok: true, seq })
          dirty = true
          if (failed) editedSinceFail = true
          if (!r.filePath || !isGeneratedPath(r.filePath)) {
            stats.locAdded += add
            stats.locRemoved += rem
            if (r.filePath) {
              const ext = normalizeExt(r.filePath)
              stats.languages[ext] = (stats.languages[ext] ?? 0) + add + rem
            }
          }
        }
      }
    }
  }

  if (currentRun > 0) runs.push(currentRun)
  if (!stats.externalId) throw new ParseError('No sessionId found in Claude Code trace')
  if (stats.messageCount === 0) throw new ParseError('No messages found in Claude Code trace')
  stats.models = [...models]
  stats.skills = [...skills].sort()
  stats.mcpServers = [...mcpServers].sort()
  stats.agenticity = median(runs)
  stats.longestRun = runs.length ? Math.max(...runs) : 0
  stats.parallelBatches = [...requestCounts.values()].filter((n) => n > 1).length
  stats.outcome = computeOutcome(events, stats.toolCallCount)
  return stats
}
```

- [ ] **Step 5: Fix the Codex parser initializer so the worker compiles**

`parseCodex` in `worker/src/parsers/codex.ts` still builds a bare `SessionStats`. Add the same 15 zero/empty fields to its initializer object (values: `0`, `{}`, `''`, `[]` matching the types) — full extraction comes in Task 3.

- [ ] **Step 6: Run all worker tests**

Run: `cd worker && npx vitest run`
Expected: PASS — new v2 tests green, existing parser/verifier tests untouched

- [ ] **Step 7: Commit**

```bash
git add worker/src/parsers/types.ts worker/src/parsers/claudeCode.ts worker/src/parsers/codex.ts worker/test/parsers.test.ts
git commit -m "feat(worker): Claude Code parser extracts v2 metrics (LOC, taxonomy, behavior, outcome)"
```

---

### Task 3: Codex parser extraction

**Files:**
- Modify: `worker/src/parsers/codex.ts` (full rewrite below)
- Test: `worker/test/parsers.test.ts` (append)

**Interfaces:**
- Consumes: heuristics (Task 1), extended `SessionStats` (Task 2).
- Produces: `parseCodex(lines)` filling all v2 fields. Codex has no requestId/skills/MCP/delegation/background concepts → those stay 0/empty by design.

- [ ] **Step 1: Write the failing test**

Append to `worker/test/parsers.test.ts`:

```ts
describe('codex v2 metrics', () => {
  const PATCH = [
    '*** Begin Patch',
    '*** Update File: /repo/src/main.py',
    '@@',
    ' context',
    '+added line one',
    '+added line two',
    '-removed line',
    '*** End Patch',
  ].join('\n')
  const lines = [
    { type: 'session_meta', timestamp: '2026-07-01T09:00:00Z', payload: { id: 'c1', cwd: '/repo' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'fix the bug' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'x1',
        arguments: JSON.stringify({ cmd: 'pytest -x' }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'x1',
        output: 'Process exited with code 1\nFAILED' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'x2',
        input: PATCH } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'x2',
        output: '{"output":"Success","metadata":{"exit_code":0}}' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'x3',
        arguments: JSON.stringify({ cmd: 'pytest -x' }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'x3',
        output: 'Process exited with code 0\n2 passed' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'x4',
        arguments: JSON.stringify({ cmd: 'git add -A && git commit -m fix' }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'x4',
        output: 'Process exited with code 0' } },
    { type: 'response_item', payload: { type: 'message', content: [{ type: 'output_text', text: 'done' }] } },
  ]

  it('extracts v2 metrics', () => {
    const s = parseCodex(lines)
    expect(s.locAdded).toBe(2)
    expect(s.locRemoved).toBe(1)
    expect(s.languages).toEqual({ py: 3 })
    expect(s.commandCounts).toEqual({ test: 2, git: 1 })
    expect(s.humanTurns).toBe(1)
    expect(s.verifiedEditCycles).toBe(1)
    expect(s.redGreenCycles).toBe(1)
    expect(s.outcome).toBe('landed')  // commit after last edit, green after first edit
    expect(s.agenticity).toBe(4)      // one run of 4 calls
    expect(s.longestRun).toBe(4)
    expect(s.delegationCalls).toBe(0)
    expect(s.skills).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd worker && npx vitest run test/parsers.test.ts`
Expected: FAIL — v2 fields are zeros from the Task 2 stub

- [ ] **Step 3: Rewrite the parser**

Replace `worker/src/parsers/codex.ts` entirely:

```ts
import {
  classifyCommand, computeOutcome, isCommit, isGeneratedPath, isShip,
  isVerify, median, normalizeExt, type OutcomeEvent,
} from './heuristics'
import { ParseError, type SessionStats } from './types'

interface CodexLine {
  type?: string
  timestamp?: string
  payload?: {
    id?: string
    cwd?: string
    type?: string
    name?: string
    model?: string
    call_id?: string
    arguments?: string
    input?: string
    output?: string
    message?: string
    info?: {
      total_token_usage?: { input_tokens?: number; output_tokens?: number }
    }
  }
}

export function looksLikeCodex(firstLines: unknown[]): boolean {
  return firstLines.some(
    (o) =>
      typeof o === 'object' &&
      o !== null &&
      ['session_meta', 'response_item', 'turn_context', 'event_msg'].includes(
        String((o as CodexLine).type),
      ),
  )
}

/** Codex exec outputs embed exit codes as text or JSON metadata. */
function codexSuccess(output: string): boolean {
  const text = output.match(/exited with code (\d+)/)
  if (text) return text[1] === '0'
  try {
    const parsed = JSON.parse(output) as { metadata?: { exit_code?: number } }
    if (typeof parsed?.metadata?.exit_code === 'number') return parsed.metadata.exit_code === 0
  } catch {
    /* not JSON */
  }
  return true
}

/** Parse an apply_patch body: returns per-file added/removed line counts. */
function parseApplyPatch(body: string): Array<{ path: string; added: number; removed: number }> {
  const files: Array<{ path: string; added: number; removed: number }> = []
  let current: { path: string; added: number; removed: number } | null = null
  for (const line of body.split('\n')) {
    const marker = line.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/)
    if (marker) {
      current = { path: marker[2].trim(), added: 0, removed: 0 }
      files.push(current)
      continue
    }
    if (line.startsWith('***') || current === null) continue
    if (line.startsWith('+')) current.added++
    else if (line.startsWith('-')) current.removed++
  }
  return files
}

export function parseCodex(lines: unknown[]): SessionStats {
  const stats: SessionStats = {
    harness: 'codex',
    externalId: '',
    startedAt: null,
    endedAt: null,
    messageCount: 0,
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    models: [],
    toolCounts: {},
    locAdded: 0,
    locRemoved: 0,
    languages: {},
    commandCounts: {},
    humanTurns: 0,
    agenticity: 0,
    longestRun: 0,
    parallelBatches: 0,
    delegationCalls: 0,
    verifiedEditCycles: 0,
    redGreenCycles: 0,
    outcome: '',
    skills: [],
    mcpServers: [],
    backgroundTasks: 0,
  }
  const models = new Set<string>()
  let lastUsage: { input_tokens?: number; output_tokens?: number } | undefined
  const callCommands = new Map<string, string>() // call_id -> cmd
  const events: OutcomeEvent[] = []
  const runs: number[] = []
  let currentRun = 0
  let dirty = false
  let failed = false
  let editedSinceFail = false
  let seq = 0

  for (const raw of lines) {
    if (typeof raw !== 'object' || raw === null) continue
    const o = raw as CodexLine
    const p = o.payload
    seq++
    if (o.timestamp) {
      if (!stats.startedAt || o.timestamp < stats.startedAt) stats.startedAt = o.timestamp
      if (!stats.endedAt || o.timestamp > stats.endedAt) stats.endedAt = o.timestamp
    }
    if (o.type === 'session_meta' && p?.id) {
      stats.externalId = p.id
      if (p.cwd) stats.cwd = p.cwd
    }
    if (o.type === 'turn_context' && p?.model) models.add(p.model)
    if (o.type === 'event_msg') {
      if (p?.type === 'user_message') {
        stats.humanTurns++
        if (currentRun > 0) runs.push(currentRun)
        currentRun = 0
      }
      if (p?.type === 'token_count' && p.info?.total_token_usage) {
        lastUsage = p.info.total_token_usage
      }
    }
    if (o.type === 'response_item' && p) {
      if (p.type === 'message') stats.messageCount++
      if (p.type === 'function_call' && p.name) {
        stats.toolCallCount++
        currentRun++
        stats.toolCounts[p.name] = (stats.toolCounts[p.name] ?? 0) + 1
        if (p.name === 'exec_command' && typeof p.arguments === 'string' && p.call_id) {
          try {
            const args = JSON.parse(p.arguments) as { cmd?: string }
            if (typeof args.cmd === 'string') {
              const cat = classifyCommand(args.cmd)
              stats.commandCounts[cat] = (stats.commandCounts[cat] ?? 0) + 1
              callCommands.set(p.call_id, args.cmd)
            }
          } catch {
            /* unparseable args */
          }
        }
      }
      if (p.type === 'custom_tool_call' && p.name === 'apply_patch' && typeof p.input === 'string') {
        currentRun++
        let touched = false
        for (const f of parseApplyPatch(p.input)) {
          if (f.added === 0 && f.removed === 0) continue
          touched = true
          if (!isGeneratedPath(f.path)) {
            stats.locAdded += f.added
            stats.locRemoved += f.removed
            const ext = normalizeExt(f.path)
            stats.languages[ext] = (stats.languages[ext] ?? 0) + f.added + f.removed
          }
        }
        if (touched) {
          events.push({ kind: 'edit', ok: true, seq })
          dirty = true
          if (failed) editedSinceFail = true
        }
      }
      if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && p.call_id) {
        const cmd = callCommands.get(p.call_id)
        if (cmd !== undefined) {
          callCommands.delete(p.call_id)
          const ok = typeof p.output === 'string' ? codexSuccess(p.output) : true
          if (isVerify(cmd)) {
            events.push({ kind: 'verify', ok, seq })
            if (ok) {
              if (dirty) {
                stats.verifiedEditCycles++
                dirty = false
              }
              if (failed && editedSinceFail) {
                stats.redGreenCycles++
                failed = false
              }
            } else {
              failed = true
              editedSinceFail = false
            }
          }
          if (ok && isCommit(cmd)) events.push({ kind: 'commit', ok: true, seq })
          if (isShip(cmd)) events.push({ kind: 'ship', ok, seq })
        }
      }
    }
  }

  if (currentRun > 0) runs.push(currentRun)
  if (!stats.externalId) throw new ParseError('No session_meta found in Codex trace')
  if (stats.messageCount === 0 && stats.toolCallCount === 0)
    throw new ParseError('No activity found in Codex trace')
  if (lastUsage) {
    stats.inputTokens = lastUsage.input_tokens ?? 0
    stats.outputTokens = lastUsage.output_tokens ?? 0
  }
  stats.models = [...models]
  stats.agenticity = median(runs)
  stats.longestRun = runs.length ? Math.max(...runs) : 0
  stats.outcome = computeOutcome(events, stats.toolCallCount)
  return stats
}
```

- [ ] **Step 4: Run all worker tests**

Run: `cd worker && npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/parsers/codex.ts worker/test/parsers.test.ts
git commit -m "feat(worker): Codex parser extracts v2 metrics via apply_patch + exec_command"
```

---

### Task 4: Schema migration and persistence

**Files:**
- Create: `worker/migrations/0005_metrics.sql`
- Modify: `worker/schema.sql` (sessions table gains the same columns)
- Modify: `worker/src/index.ts` — every sessions INSERT/UPDATE/SELECT (`worker/src/index.ts:151`, `:349-389`, `:436`, `:476`, `:499`)

**Interfaces:**
- Consumes: `SessionStats` v2 fields (Task 2).
- Produces: sessions rows carrying the 15 new columns; `SessionRow` consumers (Task 5) read `loc_added, loc_removed, languages, command_counts, human_turns, agenticity, longest_run, parallel_batches, delegation_calls, verified_edit_cycles, red_green_cycles, outcome, skills, mcp_servers, background_tasks`.

- [ ] **Step 1: Write the migration**

```sql
-- worker/migrations/0005_metrics.sql
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
ALTER TABLE sessions ADD COLUMN red_green_cycles INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN outcome TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sessions ADD COLUMN mcp_servers TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sessions ADD COLUMN background_tasks INTEGER NOT NULL DEFAULT 0;
```

Add the same 15 columns (same names/types/defaults) to the `sessions` CREATE TABLE in `worker/schema.sql`, after `project_hash`.

- [ ] **Step 2: Update persistence in index.ts**

Read `worker/src/index.ts` first. Then, in each statement that lists session columns, append the 15 new columns (same order as the migration) and bind:

```ts
      stats.locAdded,
      stats.locRemoved,
      JSON.stringify(stats.languages),
      JSON.stringify(stats.commandCounts),
      stats.humanTurns,
      stats.agenticity,
      stats.longestRun,
      stats.parallelBatches,
      stats.delegationCalls,
      stats.verifiedEditCycles,
      stats.redGreenCycles,
      stats.outcome,
      JSON.stringify(stats.skills),
      JSON.stringify(stats.mcpServers),
      stats.backgroundTasks,
```

Statements to touch (verify by grep, line numbers may drift):
- the INSERT at `worker/src/index.ts:371-389` — add columns + `?` placeholders + bindings
- the UPDATE (re-upload reprocess path) at `worker/src/index.ts:349-360` — add `loc_added = ?, … background_tasks = ?` assignments + bindings
- the SELECTs at `:151`, `:436`, `:476`, `:499` — add the 15 column names so aggregation receives them

- [ ] **Step 3: Apply migration locally and run everything**

Run:
```bash
cd worker && npx wrangler d1 execute ai-passport --local --file=migrations/0005_metrics.sql
npx vitest run
```
Expected: migration applies cleanly; all tests PASS

- [ ] **Step 4: Commit**

```bash
git add worker/migrations/0005_metrics.sql worker/schema.sql worker/src/index.ts
git commit -m "feat(worker): persist v2 metric columns (migration 0005)"
```

---

### Task 5: Aggregation and score v2

**Files:**
- Modify: `worker/src/score.ts`
- Test: `worker/test/score.test.ts` (create)

**Interfaces:**
- Consumes: `SessionRow` now includes the 15 new snake_case columns (all optional-with-defaults so pre-migration rows aggregate as zeros).
- Produces (consumed by web in Task 7 via the card API):
  - `CardData` gains: `locAdded, locRemoved: number`; `languages: Record<string, number>`; `commandMix: Array<{ category: string; count: number; share: number }>`; `testShare: number`; `outcomes: Record<string, number>`; `concludedSessions: number`; `agenticity: number` (median of session medians); `longestRun: number`; `delegationCalls: number`; `redGreenCycles: number`; `verifiedEditCycles: number`; `skills: string[]`; `mcpServers: string[]`; `backgroundTasks: number`; `maxConcurrentSessions: number`
  - Score breakdown keys exactly: `volume, codeShipped, concluded, output, verifiedCycles, delegation, toolBreadth, consistency, multiHarness`

- [ ] **Step 1: Write the failing tests**

```ts
// worker/test/score.test.ts
import { describe, expect, it } from 'vitest'
import { aggregate, type SessionRow } from '../src/score'

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    harness: 'claude-code',
    started_at: '2026-07-01T10:00:00Z',
    ended_at: '2026-07-01T12:00:00Z',
    message_count: 10,
    tool_call_count: 20,
    input_tokens: 1000,
    output_tokens: 2000,
    models: '["claude-fable-5"]',
    tool_counts: '{"Bash": 10, "Edit": 5}',
    project_hash: 'abc',
    loc_added: 0, loc_removed: 0, languages: '{}', command_counts: '{}',
    human_turns: 0, agenticity: 0, longest_run: 0, parallel_batches: 0,
    delegation_calls: 0, verified_edit_cycles: 0, red_green_cycles: 0,
    outcome: '', skills: '[]', mcp_servers: '[]', background_tasks: 0,
    ...over,
  }
}

describe('score v2', () => {
  it('dimension maxes sum to 100 and clamp', () => {
    const rows = Array.from({ length: 20000 }, (_, i) =>
      row({
        harness: i % 2 ? 'codex' : 'claude-code',
        started_at: `2026-0${(i % 6) + 1}-01T10:00:00Z`,
        output_tokens: 10_000_000_000,
        loc_added: 10_000, outcome: 'shipped',
        verified_edit_cycles: 5, delegation_calls: 5,
      }),
    )
    const card = aggregate(rows)
    expect(card.score).toBeLessThanOrEqual(100)
    const sum = Object.values(card.scoreBreakdown).reduce((a, b) => a + b, 0)
    expect(Math.round(sum)).toBe(card.score)
  })

  it('log curves: 10x output tokens ≈ +2.5 within output dimension', () => {
    const a = aggregate([row({ output_tokens: 1_000_000 })])
    const b = aggregate([row({ output_tokens: 10_000_000 })])
    expect(b.scoreBreakdown.output - a.scoreBreakdown.output).toBeCloseTo(1.67, 1) // 10/6 per decade
  })

  it('zero sessions in new dimensions score zero, not NaN', () => {
    const card = aggregate([row()])
    expect(card.scoreBreakdown.codeShipped).toBe(0)
    expect(card.scoreBreakdown.concluded).toBe(0)
    expect(Number.isFinite(card.score)).toBe(true)
  })

  it('aggregates languages, outcomes, command mix, test share', () => {
    const card = aggregate([
      row({ languages: '{"ts": 100, "rs": 50}', command_counts: '{"test": 3, "git": 7}',
            outcome: 'shipped', loc_added: 150, loc_removed: 10 }),
      row({ languages: '{"ts": 40}', command_counts: '{"other": 10}', outcome: 'research' }),
    ])
    expect(card.languages).toEqual({ ts: 140, rs: 50 })
    expect(card.outcomes).toEqual({ shipped: 1, research: 1 })
    expect(card.concludedSessions).toBe(1)
    expect(card.testShare).toBeCloseTo(0.15, 5) // 3 of 20
    expect(card.locAdded).toBe(150)
  })

  it('computes max concurrent sessions from overlapping windows', () => {
    const card = aggregate([
      row({ started_at: '2026-07-01T10:00:00Z', ended_at: '2026-07-01T12:00:00Z' }),
      row({ started_at: '2026-07-01T11:00:00Z', ended_at: '2026-07-01T13:00:00Z' }),
      row({ started_at: '2026-07-01T11:30:00Z', ended_at: '2026-07-01T11:45:00Z' }),
      row({ started_at: '2026-07-02T10:00:00Z', ended_at: '2026-07-02T11:00:00Z' }),
    ])
    expect(card.maxConcurrentSessions).toBe(3)
  })

  it('agenticity is the median of session medians', () => {
    const card = aggregate([row({ agenticity: 2 }), row({ agenticity: 6 }), row({ agenticity: 10 })])
    expect(card.agenticity).toBe(6)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd worker && npx vitest run test/score.test.ts`
Expected: FAIL — missing fields/exports

- [ ] **Step 3: Implement in score.ts**

Extend `SessionRow` (all new fields required — SELECTs from Task 4 supply them; defaults come from the schema):

```ts
export interface SessionRow {
  harness: string
  started_at: string | null
  ended_at: string | null
  message_count: number
  tool_call_count: number
  input_tokens: number
  output_tokens: number
  models: string
  tool_counts: string
  project_hash?: string | null
  loc_added: number
  loc_removed: number
  languages: string
  command_counts: string
  human_turns: number
  agenticity: number
  longest_run: number
  parallel_batches: number
  delegation_calls: number
  verified_edit_cycles: number
  red_green_cycles: number
  outcome: string
  skills: string
  mcp_servers: string
  background_tasks: number
}
```

Add to `CardData` (after `topTools`):

```ts
  locAdded: number
  locRemoved: number
  languages: Record<string, number>
  commandMix: Array<{ category: string; count: number; share: number }>
  testShare: number
  outcomes: Record<string, number>
  concludedSessions: number
  agenticity: number
  longestRun: number
  delegationCalls: number
  redGreenCycles: number
  verifiedEditCycles: number
  skills: string[]
  mcpServers: string[]
  backgroundTasks: number
  maxConcurrentSessions: number
```

Add helpers near the top of `score.ts`:

```ts
/** Log-curve contribution: 0 at 10^floorLog, max at 10^ceilLog, clamped. */
function logDim(value: number, max: number, floorLog: number, ceilLog: number): number {
  if (value <= 0) return 0
  const pts = (max * (Math.log10(value) - floorLog)) / (ceilLog - floorLog)
  return Math.min(max, Math.max(0, pts))
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function maxConcurrent(rows: SessionRow[]): number {
  const events: Array<[number, number]> = []
  for (const r of rows) {
    if (!r.started_at || !r.ended_at) continue
    events.push([Date.parse(r.started_at), 1], [Date.parse(r.ended_at), -1])
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]) // ends before starts at ties
  let cur = 0
  let peak = 0
  for (const [, d] of events) {
    cur += d
    peak = Math.max(peak, cur)
  }
  return peak
}
```

In `aggregate()`, accumulate the new per-row values (inside the existing loop):

```ts
    totalLocAdded += r.loc_added ?? 0
    totalLocRemoved += r.loc_removed ?? 0
    for (const [k, v] of Object.entries(JSON.parse(r.languages || '{}') as Record<string, number>)) {
      languageTotals[k] = (languageTotals[k] ?? 0) + v
    }
    for (const [k, v] of Object.entries(JSON.parse(r.command_counts || '{}') as Record<string, number>)) {
      commandTotals[k] = (commandTotals[k] ?? 0) + v
    }
    if (r.outcome) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1
    totalDelegation += r.delegation_calls ?? 0
    totalCycles += r.verified_edit_cycles ?? 0
    totalRedGreen += r.red_green_cycles ?? 0
    totalBackground += r.background_tasks ?? 0
    longestRun = Math.max(longestRun, r.longest_run ?? 0)
    if ((r.agenticity ?? 0) > 0) agenticities.push(r.agenticity)
    for (const sk of JSON.parse(r.skills || '[]') as string[]) allSkills.add(sk)
    for (const sv of JSON.parse(r.mcp_servers || '[]') as string[]) allMcp.add(sv)
```

Replace the breakdown with score v2 (spec formulas exactly):

```ts
  const concludedSessions = (outcomes.shipped ?? 0) + (outcomes.landed ?? 0)
  const breakdown = {
    volume: logDim(rows.length, 15, 0, 4),
    codeShipped: logDim(totalLocAdded, 15, 2, 7),
    concluded: logDim(concludedSessions + 1, 15, 0, 3),
    output: logDim(totalOutput, 10, 5, 11),
    verifiedCycles: logDim(totalCycles, 10, 0, 4),
    delegation: logDim(totalDelegation, 10, 0, 3),
    toolBreadth: Math.min(10, distinctTools),
    consistency: logDim(days.size, 10, 0, 3),
    multiHarness: harnesses.size >= 2 ? 5 : 0,
  }
```

Build the new CardData fields before returning:

```ts
  const totalCommands = Object.values(commandTotals).reduce((a, b) => a + b, 0)
  const commandMix = Object.entries(commandTotals)
    .map(([category, count]) => ({ category, count, share: totalCommands ? count / totalCommands : 0 }))
    .sort((a, b) => b.count - a.count)
```

and in the return object:

```ts
    locAdded: totalLocAdded,
    locRemoved: totalLocRemoved,
    languages: languageTotals,
    commandMix,
    testShare: totalCommands ? (commandTotals.test ?? 0) / totalCommands : 0,
    outcomes,
    concludedSessions,
    agenticity: median(agenticities),
    longestRun,
    delegationCalls: totalDelegation,
    redGreenCycles: totalRedGreen,
    verifiedEditCycles: totalCycles,
    skills: [...allSkills].sort(),
    mcpServers: [...allMcp].sort(),
    backgroundTasks: totalBackground,
    maxConcurrentSessions: maxConcurrent(rows),
```

- [ ] **Step 4: Run all worker tests, fix drift**

Run: `cd worker && npx vitest run`
Expected: PASS. Any existing score expectations pinned to v1 values must be updated to v2 (check `verifier.test.ts` and API tests for hardcoded scores/grades).

- [ ] **Step 5: Commit**

```bash
git add worker/src/score.ts worker/test/score.test.ts worker/test
git commit -m "feat(worker): score v2 — log curves, outcomes, concurrency, command mix"
```

---

### Task 6: Achievements

**Files:**
- Modify: `worker/src/score.ts` (`derive()`, `computeAchievements()`)
- Test: `worker/test/score.test.ts` (append)

**Interfaces:**
- Consumes: aggregation internals from Task 5.
- Produces: six new `Achievement` entries appended to the existing eleven, ids exactly: `polyglot, ten-thousand-lines, git-native, test-runner, full-auto, shipper, debugger, skillful, multitasker` (nine new — the spec's list).

- [ ] **Step 1: Write the failing test**

```ts
describe('achievements v2', () => {
  it('polyglot needs 5 languages with 100+ lines each', () => {
    const card = aggregate([row({
      languages: '{"ts":150,"rs":120,"py":100,"go":100,"sql":100,"md":50}',
    })])
    const a = card.achievements.find((x) => x.id === 'polyglot')!
    expect(a.earned).toBe(true)
  })
  it('shipper counts shipped + landed', () => {
    const rows = [
      ...Array.from({ length: 20 }, () => row({ outcome: 'shipped' })),
      ...Array.from({ length: 5 }, () => row({ outcome: 'landed' })),
    ]
    expect(aggregate(rows).achievements.find((x) => x.id === 'shipper')!.earned).toBe(true)
  })
  it('multitasker needs 3 concurrent sessions', () => {
    const card = aggregate([
      row({ started_at: '2026-07-01T10:00:00Z', ended_at: '2026-07-01T12:00:00Z' }),
      row({ started_at: '2026-07-01T10:30:00Z', ended_at: '2026-07-01T12:30:00Z' }),
      row({ started_at: '2026-07-01T11:00:00Z', ended_at: '2026-07-01T11:30:00Z' }),
    ])
    expect(card.achievements.find((x) => x.id === 'multitasker')!.earned).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd worker && npx vitest run test/score.test.ts`
Expected: FAIL — achievements missing

- [ ] **Step 3: Implement**

Extend `Derived` with: `locAdded: number`, `languagesOver100: number`, `gitCommands: number`, `testCommands: number`, `longestRun: number`, `concludedSessions: number`, `redGreenCycles: number`, `distinctSkills: number`, `maxConcurrent: number` — computed in `derive()` from the same row parsing as `aggregate()` (languagesOver100 counts entries of the merged language totals with value ≥ 100).

Append to `computeAchievements()`:

```ts
    tiered('polyglot', 'Polyglot', '5 languages with 100+ lines each', d.languagesOver100, 5),
    tiered('ten-thousand-lines', 'Ten Thousand Lines', '10,000 lines of code added', d.locAdded, 10_000),
    tiered('git-native', 'Git Native', '250 git commands executed', d.gitCommands, 250),
    tiered('test-runner', 'Test Runner', '100 test commands executed', d.testCommands, 100),
    tiered('full-auto', 'Full Auto', 'A 100+ tool-call autonomous run', d.longestRun, 100),
    tiered('shipper', 'Shipper', '25 sessions shipped or landed', d.concludedSessions, 25),
    tiered('debugger', 'Debugger', '25 red-to-green fix cycles', d.redGreenCycles, 25),
    tiered('skillful', 'Skillful', '10 distinct skills invoked', d.distinctSkills, 10),
    tiered('multitasker', 'Multitasker', '3 sessions running at once', d.maxConcurrent, 3),
```

- [ ] **Step 4: Run all worker tests**

Run: `cd worker && npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/score.ts worker/test/score.test.ts
git commit -m "feat(worker): nine v2 achievements (polyglot, shipper, debugger, multitasker, ...)"
```

---

### Task 7: Card UI

**Files:**
- Create: `web/src/components/LanguageBar.tsx`
- Create: `web/src/components/OutcomeBar.tsx`
- Modify: `web/src/pages/Passport.tsx`

**Interfaces:**
- Consumes: `CardData` v2 fields from the card API (Task 5 names, camelCase).
- Produces: three visual blocks. Read `Passport.tsx` first and match its existing stat-grid classes/components exactly.

- [ ] **Step 1: LanguageBar component**

```tsx
// web/src/components/LanguageBar.tsx
const DISPLAY: Record<string, string> = {
  ts: 'TypeScript', js: 'JavaScript', py: 'Python', rs: 'Rust', go: 'Go',
  md: 'Markdown', sql: 'SQL', css: 'CSS', html: 'HTML', sh: 'Shell',
  yml: 'YAML', yaml: 'YAML', json: 'JSON', tf: 'Terraform', other: 'Other',
}
const COLORS = ['bg-sky-500', 'bg-emerald-500', 'bg-amber-500', 'bg-violet-500', 'bg-rose-500', 'bg-zinc-400']

export function LanguageBar({ languages }: { languages: Record<string, number> }) {
  const entries = Object.entries(languages).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) return null
  const top = entries.slice(0, 5)
  const rest = entries.slice(5).reduce((a, [, v]) => a + v, 0)
  const parts = rest > 0 ? [...top, ['other', rest] as [string, number]] : top
  const total = parts.reduce((a, [, v]) => a + v, 0)
  return (
    <div>
      <div className="flex h-2 w-full overflow-hidden rounded-full">
        {parts.map(([k, v], i) => (
          <div key={k} className={COLORS[i % COLORS.length]} style={{ width: `${(v / total) * 100}%` }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {parts.map(([k, v], i) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${COLORS[i % COLORS.length]}`} />
            {DISPLAY[k] ?? k} {Math.round((v / total) * 100)}%
          </span>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: OutcomeBar component**

```tsx
// web/src/components/OutcomeBar.tsx
const ORDER: Array<[string, string, string]> = [
  ['shipped', 'Shipped', 'bg-emerald-500'],
  ['landed', 'Landed', 'bg-emerald-400'],
  ['green', 'Verified', 'bg-lime-400'],
  ['committed', 'Committed', 'bg-sky-400'],
  ['research', 'Research', 'bg-violet-400'],
  ['red', 'Ended red', 'bg-rose-400'],
  ['unverified', 'Unverified', 'bg-zinc-400'],
  ['trivial', 'Trivial', 'bg-zinc-300'],
]

export function OutcomeBar({ outcomes }: { outcomes: Record<string, number> }) {
  const parts = ORDER.filter(([k]) => (outcomes[k] ?? 0) > 0)
  const total = parts.reduce((a, [k]) => a + outcomes[k], 0)
  if (total === 0) return null
  return (
    <div>
      <div className="flex h-2 w-full overflow-hidden rounded-full">
        {parts.map(([k, , color]) => (
          <div key={k} className={color} style={{ width: `${(outcomes[k] / total) * 100}%` }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {parts.map(([k, label, color]) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${color}`} />
            {label} {outcomes[k]}
          </span>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Integrate into Passport.tsx**

Read `web/src/pages/Passport.tsx`. Add to its card-data type the v2 fields (mirror the `CardData` names from Task 5). Then, using the page's existing section/stat components:

1. After the existing stats grid, render a "Code" section: `<LanguageBar languages={data.languages} />` with a secondary line `+{locAdded.toLocaleString()} / −{locRemoved.toLocaleString()} lines` — secondary styling, NOT a headline (spec: LOC is deliberately demoted).
2. A "Session outcomes" section: `<OutcomeBar outcomes={data.outcomes} />` plus the callout line `{concludedSessions} sessions shipped or landed · {verifiedEditCycles} verified edit cycles`. If `concludedSessions === 0 && totalSessions > 0`, show the hint `re-upload sessions to count shipped work`.
3. A "Working style" row of small stats in the existing grid style: agenticity (`{agenticity} tool calls per prompt (median)`), longest run, delegation calls, red→green cycles, skills used (`skills.length`), background tasks, max concurrent sessions (only render entries with nonzero values).
4. Command mix: one line under top tools — top 4 of `commandMix` as `{category} {Math.round(share * 100)}%`, plus `test share {Math.round(testShare * 100)}%`.

Hide sections entirely (no empty shells) when their data is all zeros — pre-migration passports must look unchanged except the re-upload hint.

- [ ] **Step 4: Build and eyeball**

Run:
```bash
cd web && npm run build
cd ../worker && npx wrangler dev
```
Expected: build clean; upload a real trace at http://localhost:8787, confirm bars render and zero-data passports show no empty sections.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/LanguageBar.tsx web/src/components/OutcomeBar.tsx web/src/pages/Passport.tsx
git commit -m "feat(web): language bar, outcome bar, working-style row, command mix"
```

---

### Task 8: Rust heuristics port

**Files:**
- Modify: `verifier/crates/passport-verifier/Cargo.toml` (add `regex = "1"` to `[dependencies]`)
- Create: `verifier/crates/passport-verifier/src/parsers/heuristics.rs`
- Modify: `verifier/crates/passport-verifier/src/parsers/mod.rs` (add `mod heuristics;` and `pub(crate) use` items)

**Interfaces:**
- Produces (consumed by Tasks 9, 10): `classify_command(&str) -> &'static str`, `is_verify(&str) -> bool`, `is_commit(&str) -> bool`, `is_ship(&str) -> bool`, `is_generated_path(&str) -> bool`, `normalize_ext(&str) -> String`, `median(&[f64]) -> f64`, `OutcomeEvent { kind: EventKind, ok: bool, seq: usize }`, `enum EventKind { Edit, Verify, Commit, Ship }`, `compute_outcome(&[OutcomeEvent], u64) -> String`.
- MUST mirror `worker/src/parsers/heuristics.ts` logic exactly — same regexes, same precedence, same outcome rules.

- [ ] **Step 1: Write failing tests (in-module `#[cfg(test)]`)**

Port every case from `worker/test/heuristics.test.ts` verbatim — same inputs, same expected strings. Include all 15 classify cases, the deprefix cases, verify/commit/ship, paths, median, and all 9 computeOutcome cases.

- [ ] **Step 2: Run to verify failure**

Run: `cd verifier && cargo test -p passport-verifier heuristics`
Expected: FAIL — module missing

- [ ] **Step 3: Implement**

```rust
// verifier/crates/passport-verifier/src/parsers/heuristics.rs
//! Shared trace heuristics — line-for-line port of worker/src/parsers/heuristics.ts.
//! Any change here MUST be mirrored there; shared test fixtures enforce parity.

use regex::Regex;
use std::sync::LazyLock;

static PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(cd\s|export\s|source\s|nvm\s|conda\s|\w+=\S*\s*$)").unwrap());

static RULES: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    vec![
        ("test", Regex::new(r"\b(vitest|jest|pytest|playwright|nextest|(cargo|go|npm|pnpm|yarn|bun|make) test)\b").unwrap()),
        ("build", Regex::new(r"\b((npm|pnpm|yarn|bun) run build|cargo build|tsc\b|vite build|make(\s|$)|docker build)\b").unwrap()),
        ("package", Regex::new(r"\b((npm|pnpm|yarn|bun) (install|add|i)\b|pip3? install|cargo add|brew install)").unwrap()),
        ("git", Regex::new(r"(^|\s)git\s").unwrap()),
        ("search", Regex::new(r"^\s*(grep|rg|find|fd|ag)\b").unwrap()),
        ("network", Regex::new(r"^\s*(curl|wget|gh|ssh)\b").unwrap()),
        ("ops", Regex::new(r"^\s*(kubectl|docker|terraform|wrangler|aws|gcloud|flyctl|npx wrangler)\b").unwrap()),
        ("run", Regex::new(r"^\s*(node|python3?|npx|bash|sh|cargo run|(npm|pnpm|yarn|bun) run|\./)").unwrap()),
        ("file", Regex::new(r"^\s*(ls|cat|mkdir|cp|mv|rm|touch|head|tail|wc|sed|awk|echo|printf|chmod|sqlite3|jq|diff|tar|unzip)\b").unwrap()),
    ]
});

static COMMIT_RX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bgit\b[^|;&]*\bcommit\b").unwrap());
static SHIP_RX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\bgit push\b|\bgh pr create\b|\bwrangler (deploy|publish)\b|\bflyctl deploy\b").unwrap()
});
static GENERATED_RX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"package-lock\.json|Cargo\.lock|pnpm-lock\.yaml|yarn\.lock|\.min\.(js|css)$|/node_modules/|/dist/|/target/|/build/").unwrap()
});

pub(crate) fn deprefix(cmd: &str) -> String {
    let mut segs: Vec<&str> = cmd.split(|c| c == ';').flat_map(|s| s.split("&&")).collect();
    while let Some(first) = segs.first() {
        let probe = format!("{} ", first.trim());
        if PREFIX.is_match(&probe) {
            segs.remove(0);
        } else {
            break;
        }
    }
    let joined = segs.join("&&").trim().to_string();
    if joined.is_empty() { cmd.to_string() } else { joined }
}

pub(crate) fn classify_command(cmd: &str) -> &'static str {
    let c = deprefix(cmd);
    for (name, rx) in RULES.iter() {
        if rx.is_match(&c) {
            return name;
        }
    }
    "other"
}

pub(crate) fn is_verify(cmd: &str) -> bool {
    matches!(classify_command(cmd), "test" | "build")
}

pub(crate) fn is_commit(cmd: &str) -> bool {
    COMMIT_RX.is_match(cmd)
}

pub(crate) fn is_ship(cmd: &str) -> bool {
    SHIP_RX.is_match(cmd)
}

pub(crate) fn is_generated_path(path: &str) -> bool {
    GENERATED_RX.is_match(path)
}

pub(crate) fn normalize_ext(path: &str) -> String {
    let base = path.rsplit('/').next().unwrap_or(path);
    match base.rfind('.') {
        Some(dot) if dot > 0 => {
            let ext = base[dot + 1..].to_lowercase();
            match ext.as_str() {
                "tsx" => "ts".into(),
                "jsx" | "mjs" | "cjs" => "js".into(),
                "pyi" => "py".into(),
                _ => ext,
            }
        }
        _ => "other".into(),
    }
}

pub(crate) fn median(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut s = values.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mid = s.len() / 2;
    if s.len() % 2 == 1 { s[mid] } else { (s[mid - 1] + s[mid]) / 2.0 }
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum EventKind {
    Edit,
    Verify,
    Commit,
    Ship,
}

pub(crate) struct OutcomeEvent {
    pub kind: EventKind,
    pub ok: bool,
    pub seq: usize,
}

pub(crate) fn compute_outcome(events: &[OutcomeEvent], tool_call_count: u64) -> String {
    let edits: Vec<usize> = events
        .iter()
        .filter(|e| e.kind == EventKind::Edit)
        .map(|e| e.seq)
        .collect();
    if edits.is_empty() {
        return if tool_call_count >= 10 { "research" } else { "trivial" }.to_string();
    }
    let first_edit = *edits.iter().min().unwrap();
    let last_edit = *edits.iter().max().unwrap();
    if events.iter().any(|e| e.kind == EventKind::Ship && e.ok && e.seq > last_edit) {
        return "shipped".to_string();
    }
    let verifies: Vec<&OutcomeEvent> = events.iter().filter(|e| e.kind == EventKind::Verify).collect();
    let green_after_first = verifies.iter().any(|e| e.ok && e.seq > first_edit);
    let commit_after_last = events
        .iter()
        .any(|e| e.kind == EventKind::Commit && e.ok && e.seq > last_edit);
    if commit_after_last && green_after_first {
        return "landed".to_string();
    }
    if commit_after_last && verifies.is_empty() {
        return "committed".to_string();
    }
    let post: Vec<&&OutcomeEvent> = verifies.iter().filter(|e| e.seq > first_edit).collect();
    if let Some(last) = post.last() {
        return if last.ok { "green" } else { "red" }.to_string();
    }
    "unverified".to_string()
}
```

(Adjust `LazyLock` to `once_cell::sync::Lazy` if the toolchain predates 1.80 — check `rust-toolchain.toml`.)

- [ ] **Step 4: Run tests**

Run: `cd verifier && cargo test -p passport-verifier heuristics`
Expected: PASS (all ported cases)

- [ ] **Step 5: Commit**

```bash
git add verifier/crates/passport-verifier/Cargo.toml verifier/Cargo.lock verifier/crates/passport-verifier/src/parsers/heuristics.rs verifier/crates/passport-verifier/src/parsers/mod.rs
git commit -m "feat(verifier): Rust heuristics port with parity tests"
```

---

### Task 9: Rust SessionStats + Claude Code parser

**Files:**
- Modify: `verifier/crates/passport-verifier/src/parsers/mod.rs` (SessionStats fields)
- Modify: `verifier/crates/passport-verifier/src/parsers/claude_code.rs`

**Interfaces:**
- Consumes: heuristics (Task 8).
- Produces: `SessionStats` with snake_case serialized fields matching the D1 column names the worker expects from the enclave response: `loc_added, loc_removed, languages, command_counts, human_turns, agenticity, longest_run, parallel_batches, delegation_calls, verified_edit_cycles, red_green_cycles, outcome, skills, mcp_servers, background_tasks`.

- [ ] **Step 1: Extend SessionStats in mod.rs**

Append to the struct (after `project_hash`), keeping the existing serde style:

```rust
    #[serde(with = "qos_json::string_or_numeric")]
    pub loc_added: u64,
    #[serde(with = "qos_json::string_or_numeric")]
    pub loc_removed: u64,
    pub languages: BTreeMap<String, u64>,
    pub command_counts: BTreeMap<String, u64>,
    #[serde(with = "qos_json::string_or_numeric")]
    pub human_turns: u64,
    pub agenticity: f64,
    #[serde(with = "qos_json::string_or_numeric")]
    pub longest_run: u64,
    #[serde(with = "qos_json::string_or_numeric")]
    pub parallel_batches: u64,
    #[serde(with = "qos_json::string_or_numeric")]
    pub delegation_calls: u64,
    #[serde(with = "qos_json::string_or_numeric")]
    pub verified_edit_cycles: u64,
    #[serde(with = "qos_json::string_or_numeric")]
    pub red_green_cycles: u64,
    pub outcome: String,
    pub skills: Vec<String>,
    pub mcp_servers: Vec<String>,
    #[serde(with = "qos_json::string_or_numeric")]
    pub background_tasks: u64,
```

(If `qos_json::string_or_numeric` rejects f64, serialize `agenticity` as a plain f64 — check how the worker's `verifier.ts` deserializes before deciding; the worker side must parse it as a number either way.)

- [ ] **Step 2: Write failing parity test**

In `claude_code.rs` `#[cfg(test)]`, build the SAME fixture as the TS test in Task 2 (same JSON lines as raw strings) and assert the SAME numbers: `loc_added == 5`, `loc_removed == 1`, `languages == {ts: 6}`, `command_counts == {test: 2, git: 2}`, `human_turns == 2`, `longest_run == 6`, `agenticity == 4.5`, `parallel_batches == 1`, `delegation_calls == 1`, `verified_edit_cycles == 1`, `red_green_cycles == 1`, `outcome == "shipped"`, `skills == ["dataviz"]`, `mcp_servers == ["claude-in-chrome"]`, `background_tasks == 1`.

Run: `cd verifier && cargo test -p passport-verifier claude_code`
Expected: FAIL — fields missing / zeros

- [ ] **Step 3: Port the parser**

Mirror the Task 2 TypeScript structure in `claude_code.rs` exactly: human-prompt filter (string content not starting `<`/`{`, or block array with text and no tool_result; skip `isMeta`/`isSidechain`), run tracking, requestId batch counting, `attributionSkill`/`attributionMcpServer` + Skill-input + `mcp__` prefix collection, Bash id→command map, tool_result pairing with `is_error`, `toolUseResult` LOC extraction (`create` content line count + structuredPatch `+`/`-`), generated-path exclusion, dirty/failed cycle flags, events → `compute_outcome`. Use `serde_json::Value` accessors as the existing parser does (`v.get("...").and_then(Value::as_str)` style). Sort `skills`/`mcp_servers` (collect into `BTreeSet`, then `Vec`).

Zero-fill all new fields in `codex.rs`'s initializer so the crate compiles (full port is Task 10).

- [ ] **Step 4: Run tests**

Run: `cd verifier && cargo test -p passport-verifier`
Expected: PASS including parity assertions

- [ ] **Step 5: Commit**

```bash
git add verifier/crates/passport-verifier/src/parsers/
git commit -m "feat(verifier): Claude Code parser v2 metrics, TS-parity tested"
```

---

### Task 10: Rust Codex parser

**Files:**
- Modify: `verifier/crates/passport-verifier/src/parsers/codex.rs`

**Interfaces:**
- Consumes: heuristics (Task 8), SessionStats (Task 9).
- Produces: codex parity with Task 3.

- [ ] **Step 1: Write failing parity test**

Port the Task 3 codex fixture (same JSON lines, same apply_patch body) into `codex.rs` `#[cfg(test)]`; assert the same numbers (`loc_added == 2`, `languages == {py: 3}`, `outcome == "landed"`, `agenticity == 4.0`, etc.).

Run: `cd verifier && cargo test -p passport-verifier codex`
Expected: FAIL

- [ ] **Step 2: Port the parser**

Mirror Task 3 exactly: `user_message` human turns, `function_call`/`custom_tool_call` run counting, exec_command arguments JSON → classify + call_id map, apply_patch body parsing (`*** (Update|Add|Delete) File:` markers, `+`/`-` payload lines), output success (`exited with code (\d+)` text match, else JSON `metadata.exit_code`, else true), cycle flags, events → `compute_outcome`. Codex leaves `parallel_batches`, `delegation_calls`, `skills`, `mcp_servers`, `background_tasks` at zero/empty.

- [ ] **Step 3: Run tests**

Run: `cd verifier && cargo test -p passport-verifier`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add verifier/crates/passport-verifier/src/parsers/codex.rs
git commit -m "feat(verifier): Codex parser v2 metrics, TS-parity tested"
```

---

### Task 11: End-to-end wiring and verification

**Files:**
- Modify: `worker/src/verifier.ts` (enclave response → SessionStats mapping, if it maps fields explicitly — read it first; if it passes stats through verbatim, only the type needs the new fields)
- Modify: `verifier/crates/e2e` (extend the analyze assertion)
- Test: full suite, both stacks

- [ ] **Step 1: Wire the enclave response**

Read `worker/src/verifier.ts`. Where the enclave's `/analyze` response becomes `SessionStats`, map the 15 new snake_case fields to camelCase (or extend the existing mapping table). Numbers may arrive via `string_or_numeric` — coerce with `Number(...)`.

- [ ] **Step 2: Extend e2e**

In `verifier/crates/e2e`, find the `/analyze` response assertion and add checks that `loc_added`, `command_counts`, and `outcome` are present in the signed payload for the fixture trace.

- [ ] **Step 3: Full verification sweep**

Run:
```bash
cd worker && npx vitest run
cd ../verifier && cargo test -p passport-verifier && make run &
cd ../worker && npx wrangler dev
```
Expected: all tests PASS; then upload a real local trace through the UI with the local enclave running and confirm (a) `verification: 'enclave'`, (b) new card sections render with real numbers, (c) a pre-existing passport still renders without the new sections.

- [ ] **Step 4: Commit**

```bash
git add worker/src/verifier.ts verifier/crates/e2e
git commit -m "feat: enclave→worker v2 field wiring + e2e assertions"
```

---

## Deferred (explicitly NOT in this plan, per spec)

- Churn ratio, plan-mode detection, interrupt/denial signals, image counts — batch two.
- R2 ciphertext reprocessing — backfill is via re-upload.
- `/about` verification-honesty paragraph — copy change, do it with the deploy PR.
- Production enclave deploy (manifest bump) — separate ship checklist, after review.

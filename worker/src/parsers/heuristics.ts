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

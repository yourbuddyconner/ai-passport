import { ParseError, type SessionStats } from './types'
import { looksLikeClaudeCode, parseClaudeCode } from './claudeCode'
import { looksLikeCodex, parseCodex } from './codex'

export { ParseError } from './types'
export type { SessionStats, Harness } from './types'

/** Parse a raw JSONL trace, auto-detecting the harness. */
export function parseTrace(text: string): SessionStats {
  const lines: unknown[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      lines.push(JSON.parse(trimmed))
    } catch {
      // tolerate the odd corrupt line
    }
  }
  if (lines.length === 0) throw new ParseError('File is not valid JSONL')

  const head = lines.slice(0, 10)
  if (looksLikeClaudeCode(head)) return parseClaudeCode(lines)
  if (looksLikeCodex(head)) return parseCodex(lines)
  throw new ParseError('Unrecognized trace format (expected Claude Code or Codex JSONL)')
}

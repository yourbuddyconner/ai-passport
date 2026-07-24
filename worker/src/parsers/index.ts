import { ParseError, type SessionStats } from './types'
import { looksLikeClaudeCode, parseClaudeCode } from './claudeCode'
import { looksLikeCodex, parseCodex } from './codex'

export { ParseError } from './types'
export type { SessionStats, Harness } from './types'

/**
 * Parse each line of `text` as a JSON value, tolerating the odd corrupt or
 * blank line (they're simply skipped rather than aborting the whole trace).
 */
function* parsedLines(text: string): Generator<unknown> {
  // Walk the string with indexOf('\n') from a moving offset instead of
  // text.split('\n') — split materializes an array holding every line of
  // the trace at once, which for a many-MB JSONL file multiplies peak
  // memory several times over. Slicing one line at a time yields the same
  // lines without ever building that array.
  let offset = 0
  while (offset <= text.length) {
    const newlineIndex = text.indexOf('\n', offset)
    const end = newlineIndex === -1 ? text.length : newlineIndex
    const line = text.slice(offset, end)
    const trimmed = line.trim()
    if (trimmed) {
      try {
        yield JSON.parse(trimmed)
      } catch {
        // tolerate the odd corrupt line
      }
    }
    if (newlineIndex === -1) break
    offset = newlineIndex + 1
  }
}

/**
 * Parse a raw JSONL trace, auto-detecting the harness.
 *
 * Streams the trace at most twice: once (truncated to 10 lines) to sniff
 * which harness produced it, and once more, in full, through that harness's
 * parser. Neither pass collects the whole trace into memory — traces can be
 * tens of megabytes of JSONL, and an array of every line multiplies that
 * several times over.
 */
export function parseTrace(text: string): SessionStats {
  const head: unknown[] = []
  for (const line of parsedLines(text)) {
    head.push(line)
    if (head.length >= 10) break
  }
  if (head.length === 0) throw new ParseError('File is not valid JSONL')

  if (looksLikeClaudeCode(head)) return parseClaudeCode(parsedLines(text))
  if (looksLikeCodex(head)) return parseCodex(parsedLines(text))
  throw new ParseError('Unrecognized trace format (expected Claude Code or Codex JSONL)')
}

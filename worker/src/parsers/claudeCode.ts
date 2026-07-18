import { ParseError, type SessionStats } from './types'

interface ClaudeLine {
  type?: string
  sessionId?: string
  cwd?: string
  timestamp?: string
  message?: {
    model?: string
    usage?: { input_tokens?: number; output_tokens?: number }
    content?: Array<{ type?: string; name?: string }> | string
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
  }
  const models = new Set<string>()

  for (const raw of lines) {
    if (typeof raw !== 'object' || raw === null) continue
    const o = raw as ClaudeLine
    if (!stats.externalId && o.sessionId) stats.externalId = o.sessionId
    if (!stats.cwd && o.cwd) stats.cwd = o.cwd
    if (o.timestamp) {
      if (!stats.startedAt || o.timestamp < stats.startedAt) stats.startedAt = o.timestamp
      if (!stats.endedAt || o.timestamp > stats.endedAt) stats.endedAt = o.timestamp
    }
    if (o.type !== 'user' && o.type !== 'assistant') continue
    stats.messageCount++
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
          if (block?.type === 'tool_use' && block.name) {
            stats.toolCallCount++
            stats.toolCounts[block.name] = (stats.toolCounts[block.name] ?? 0) + 1
          }
        }
      }
    }
  }

  if (!stats.externalId) throw new ParseError('No sessionId found in Claude Code trace')
  if (stats.messageCount === 0) throw new ParseError('No messages found in Claude Code trace')
  stats.models = [...models]
  return stats
}

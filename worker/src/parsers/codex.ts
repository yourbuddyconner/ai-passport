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
    role?: string
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

  for (const raw of lines) {
    if (typeof raw !== 'object' || raw === null) continue
    const o = raw as CodexLine
    const p = o.payload
    if (o.timestamp) {
      if (!stats.startedAt || o.timestamp < stats.startedAt) stats.startedAt = o.timestamp
      if (!stats.endedAt || o.timestamp > stats.endedAt) stats.endedAt = o.timestamp
    }
    if (o.type === 'session_meta' && p?.id) {
      stats.externalId = p.id
      if (p.cwd) stats.cwd = p.cwd
    }
    if (o.type === 'turn_context' && p?.model) models.add(p.model)
    if (o.type === 'response_item' && p) {
      if (p.type === 'message') stats.messageCount++
      if (p.type === 'function_call' && p.name) {
        stats.toolCallCount++
        stats.toolCounts[p.name] = (stats.toolCounts[p.name] ?? 0) + 1
      }
    }
    if (o.type === 'event_msg' && p?.type === 'token_count' && p.info?.total_token_usage) {
      lastUsage = p.info.total_token_usage
    }
  }

  if (!stats.externalId) throw new ParseError('No session_meta found in Codex trace')
  if (stats.messageCount === 0 && stats.toolCallCount === 0)
    throw new ParseError('No activity found in Codex trace')
  if (lastUsage) {
    stats.inputTokens = lastUsage.input_tokens ?? 0
    stats.outputTokens = lastUsage.output_tokens ?? 0
  }
  stats.models = [...models]
  return stats
}

export type Harness = 'claude-code' | 'codex'

export interface SessionStats {
  harness: Harness
  externalId: string
  startedAt: string | null
  endedAt: string | null
  messageCount: number
  toolCallCount: number
  inputTokens: number
  outputTokens: number
  models: string[]
  toolCounts: Record<string, number>
}

export class ParseError extends Error {}

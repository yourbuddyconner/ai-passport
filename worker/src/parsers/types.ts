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
  /** Raw session cwd (never stored) — hash before persisting. */
  cwd?: string | null
  /** Truncated SHA-256 of cwd; set by the enclave or hashed locally. */
  projectHash?: string | null
}

export class ParseError extends Error {}

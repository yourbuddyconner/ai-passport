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
  /** Input tokens served from prompt cache. Claude Code reports this as
   * `cache_read_input_tokens` (disjoint from `input_tokens`); Codex as
   * `cached_input_tokens` (a subset of its `input_tokens`). */
  cacheReadTokens: number
  /** Input tokens written into the prompt cache (Claude Code only). */
  cacheCreationTokens: number
  /** Reasoning/thinking output tokens (Codex `reasoning_output_tokens`;
   * Claude Code folds thinking into `output_tokens`, so this stays 0). */
  reasoningOutputTokens: number
  /** Server-side web tool invocations, summed once per API request. */
  webSearchRequests: number
  webFetchRequests: number
  /** Subagent (Task tool) spend, summed from completed results'
   * `toolUseResult.usage` — the only record of it in the uploaded trace;
   * the subagent transcripts themselves live in separate files. Deduped by
   * agentId so an async completion re-post never double-counts. */
  subagentInputTokens: number
  subagentOutputTokens: number
  subagentCacheReadTokens: number
  subagentCacheCreationTokens: number
  models: string[]
  toolCounts: Record<string, number>
  /** Raw session cwd (never stored) — hash before persisting. */
  cwd?: string | null
  /** Truncated SHA-256 of cwd; set by the enclave or hashed locally. */
  projectHash?: string | null
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
}

export class ParseError extends Error {}

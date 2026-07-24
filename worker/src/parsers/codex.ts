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

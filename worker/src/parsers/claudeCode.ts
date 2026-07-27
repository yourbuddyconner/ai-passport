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
    status?: string
    agentId?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
  message?: {
    id?: string
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
      server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number }
    }
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

export function parseClaudeCode(lines: Iterable<unknown>): SessionStats {
  const stats: SessionStats = {
    harness: 'claude-code',
    externalId: '',
    startedAt: null,
    endedAt: null,
    messageCount: 0,
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningOutputTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    subagentInputTokens: 0,
    subagentOutputTokens: 0,
    subagentCacheReadTokens: 0,
    subagentCacheCreationTokens: 0,
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
  // Claude Code splits one API response across several JSONL lines (one per
  // content block), repeating the same usage object and requestId on each.
  // Usage and messageCount therefore dedupe on requestId (falling back to
  // message.id, then to a per-line key): max per field per request, summed
  // after the loop. Max (not first-wins) also absorbs the rare trace where
  // usage grows across lines of one request.
  const usageByRequest = new Map<string, [number, number, number, number, number, number]>()
  const assistantMessages = new Set<string>()
  const subagentsSeen = new Set<string>()
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
    if (o.isSidechain) continue
    if (o.attributionSkill) skills.add(String(o.attributionSkill))
    if (o.attributionMcpServer) mcpServers.add(String(o.attributionMcpServer))
    if (o.type !== 'user' && o.type !== 'assistant') continue
    if (o.type === 'user') {
      stats.messageCount++
    } else {
      const key = o.requestId ?? o.message?.id ?? `line-${seq}`
      if (!assistantMessages.has(key)) {
        assistantMessages.add(key)
        stats.messageCount++
      }
      const u = o.message?.usage
      if (u) {
        const entry = usageByRequest.get(key) ?? [0, 0, 0, 0, 0, 0]
        entry[0] = Math.max(entry[0], u.input_tokens ?? 0)
        entry[1] = Math.max(entry[1], u.output_tokens ?? 0)
        entry[2] = Math.max(entry[2], u.cache_read_input_tokens ?? 0)
        entry[3] = Math.max(entry[3], u.cache_creation_input_tokens ?? 0)
        entry[4] = Math.max(entry[4], u.server_tool_use?.web_search_requests ?? 0)
        entry[5] = Math.max(entry[5], u.server_tool_use?.web_fetch_requests ?? 0)
        usageByRequest.set(key, entry)
      }
    }

    if (isHumanPrompt(o)) {
      stats.humanTurns++
      if (currentRun > 0) runs.push(currentRun)
      currentRun = 0
      continue
    }

    if (o.type === 'assistant' && o.message) {
      // Claude Code marks system-generated lines with model "<synthetic>".
      if (o.message.model && !o.message.model.startsWith('<')) models.add(o.message.model)
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
      // Completed subagent (Task) result: sum its usage once per agentId.
      // async_launched results carry no usage; a later completion re-post
      // for the same agentId is deduped.
      if (r?.usage && r.status === 'completed') {
        const agentKey = r.agentId ?? `line-${seq}`
        if (!subagentsSeen.has(agentKey)) {
          subagentsSeen.add(agentKey)
          stats.subagentInputTokens += r.usage.input_tokens ?? 0
          stats.subagentOutputTokens += r.usage.output_tokens ?? 0
          stats.subagentCacheReadTokens += r.usage.cache_read_input_tokens ?? 0
          stats.subagentCacheCreationTokens += r.usage.cache_creation_input_tokens ?? 0
        }
      }
      if (r && (Array.isArray(r.structuredPatch) || r.type === 'create')) {
        let add = 0
        let rem = 0
        if (r.type === 'create' && typeof r.content === 'string') {
          const body = r.content.endsWith('\n') ? r.content.slice(0, -1) : r.content
          add = body === '' ? 0 : body.split('\n').length
        } else if (Array.isArray(r.structuredPatch)) {
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
  for (const [inp, out, read, create, search, fetch] of usageByRequest.values()) {
    stats.inputTokens += inp
    stats.outputTokens += out
    stats.cacheReadTokens += read
    stats.cacheCreationTokens += create
    stats.webSearchRequests += search
    stats.webFetchRequests += fetch
  }
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

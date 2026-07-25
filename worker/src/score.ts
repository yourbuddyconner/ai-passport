export interface SessionRow {
  harness: string
  started_at: string | null
  ended_at: string | null
  message_count: number
  tool_call_count: number
  input_tokens: number
  output_tokens: number
  models: string
  tool_counts: string
  project_hash?: string | null
  loc_added: number
  loc_removed: number
  languages: string
  command_counts: string
  human_turns: number
  agenticity: number
  longest_run: number
  parallel_batches: number
  delegation_calls: number
  verified_edit_cycles: number
  red_green_cycles: number
  outcome: string
  skills: string
  mcp_servers: string
  background_tasks: number
}

export interface Achievement {
  id: string
  name: string
  description: string
  earned: boolean
  /** Progress toward the goal, for the not-yet-earned incentive. */
  progress: { current: number; target: number } | null
}

export interface CardData {
  totalSessions: number
  repositories: number
  achievements: Achievement[]
  totalMessages: number
  totalToolCalls: number
  totalInputTokens: number
  totalOutputTokens: number
  activeHours: number
  activeDays: number
  firstActivity: string | null
  lastActivity: string | null
  harnesses: string[]
  models: string[]
  topTools: Array<{ name: string; count: number }>
  score: number
  grade: string
  scoreBreakdown: Record<string, number>
  locAdded: number
  locRemoved: number
  languages: Record<string, number>
  commandMix: Array<{ category: string; count: number; share: number }>
  testShare: number
  outcomes: Record<string, number>
  concludedSessions: number
  agenticity: number
  longestRun: number
  delegationCalls: number
  redGreenCycles: number
  verifiedEditCycles: number
  skills: string[]
  mcpServers: string[]
  backgroundTasks: number
  maxConcurrentSessions: number
}

export const GRADES: Array<[number, string]> = [
  [80, 'AI-Native'],
  [55, 'Power User'],
  [30, 'Practitioner'],
  [0, 'Novice'],
]

export function gradeForScore(score: number): string {
  return GRADES.find(([min]) => score >= min)![1]
}

/** Log-curve contribution: 0 at 10^floorLog, max at 10^ceilLog, clamped. */
function logDim(value: number, max: number, floorLog: number, ceilLog: number): number {
  if (value <= 0) return 0
  const pts = (max * (Math.log10(value) - floorLog)) / (ceilLog - floorLog)
  return Math.min(max, Math.max(0, pts))
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function maxConcurrent(rows: SessionRow[]): number {
  const events: Array<[number, number]> = []
  for (const r of rows) {
    if (!r.started_at || !r.ended_at) continue
    events.push([Date.parse(r.started_at), 1], [Date.parse(r.ended_at), -1])
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]) // ends before starts at ties
  let cur = 0
  let peak = 0
  for (const [, d] of events) {
    cur += d
    peak = Math.max(peak, cur)
  }
  return peak
}

export function aggregate(rows: SessionRow[]): CardData {
  const harnesses = new Set<string>()
  const models = new Set<string>()
  const toolTotals: Record<string, number> = {}
  const days = new Set<string>()
  let totalMessages = 0
  let totalToolCalls = 0
  let totalInput = 0
  let totalOutput = 0
  let activeMs = 0
  let first: string | null = null
  let last: string | null = null

  let totalLocAdded = 0
  let totalLocRemoved = 0
  const languageTotals: Record<string, number> = {}
  const commandTotals: Record<string, number> = {}
  const outcomes: Record<string, number> = {}
  let totalDelegation = 0
  let totalCycles = 0
  let totalRedGreen = 0
  let totalBackground = 0
  let longestRun = 0
  const agenticities: number[] = []
  const allSkills = new Set<string>()
  const allMcp = new Set<string>()

  for (const r of rows) {
    harnesses.add(r.harness)
    totalMessages += r.message_count
    totalToolCalls += r.tool_call_count
    totalInput += r.input_tokens
    totalOutput += r.output_tokens
    for (const m of JSON.parse(r.models || '[]') as string[]) models.add(m)
    const counts = JSON.parse(r.tool_counts || '{}') as Record<string, number>
    for (const [name, n] of Object.entries(counts)) {
      toolTotals[name] = (toolTotals[name] ?? 0) + n
    }
    if (r.started_at) {
      days.add(r.started_at.slice(0, 10))
      if (!first || r.started_at < first) first = r.started_at
    }
    if (r.ended_at) {
      days.add(r.ended_at.slice(0, 10))
      if (!last || r.ended_at > last) last = r.ended_at
      if (r.started_at) {
        activeMs += Math.max(0, Date.parse(r.ended_at) - Date.parse(r.started_at))
      }
    }

    totalLocAdded += r.loc_added ?? 0
    totalLocRemoved += r.loc_removed ?? 0
    for (const [k, v] of Object.entries(JSON.parse(r.languages || '{}') as Record<string, number>)) {
      languageTotals[k] = (languageTotals[k] ?? 0) + v
    }
    for (const [k, v] of Object.entries(JSON.parse(r.command_counts || '{}') as Record<string, number>)) {
      commandTotals[k] = (commandTotals[k] ?? 0) + v
    }
    if (r.outcome) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1
    totalDelegation += r.delegation_calls ?? 0
    totalCycles += r.verified_edit_cycles ?? 0
    totalRedGreen += r.red_green_cycles ?? 0
    totalBackground += r.background_tasks ?? 0
    longestRun = Math.max(longestRun, r.longest_run ?? 0)
    if ((r.agenticity ?? 0) > 0) agenticities.push(r.agenticity)
    for (const sk of JSON.parse(r.skills || '[]') as string[]) allSkills.add(sk)
    for (const sv of JSON.parse(r.mcp_servers || '[]') as string[]) allMcp.add(sv)
  }

  const derived = derive(rows)
  const distinctTools = Object.keys(toolTotals).length
  const concludedSessions = (outcomes.shipped ?? 0) + (outcomes.landed ?? 0)
  // Transparent 0-100 score: log-curve contributions per dimension.
  const breakdown = {
    volume: logDim(rows.length, 15, 0, 4),
    codeShipped: logDim(totalLocAdded, 15, 2, 7),
    concluded: logDim(concludedSessions + 1, 15, 0, 3),
    output: logDim(totalOutput, 10, 5, 11),
    verifiedCycles: logDim(totalCycles, 10, 0, 4),
    delegation: logDim(totalDelegation, 10, 0, 3),
    toolBreadth: Math.min(10, distinctTools),
    consistency: logDim(days.size, 10, 0, 3),
    multiHarness: harnesses.size >= 2 ? 5 : 0,
  }
  const score = Math.round(
    Object.values(breakdown).reduce((a, b) => a + b, 0),
  )
  const grade = gradeForScore(score)

  const totalCommands = Object.values(commandTotals).reduce((a, b) => a + b, 0)
  const commandMix = Object.entries(commandTotals)
    .map(([category, count]) => ({ category, count, share: totalCommands ? count / totalCommands : 0 }))
    .sort((a, b) => b.count - a.count)

  return {
    totalSessions: rows.length,
    repositories: derived.repositories,
    achievements: computeAchievements(derived),
    totalMessages,
    totalToolCalls,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    activeHours: Math.round((activeMs / 3_600_000) * 10) / 10,
    activeDays: days.size,
    firstActivity: first,
    lastActivity: last,
    harnesses: [...harnesses],
    models: [...models],
    topTools: Object.entries(toolTotals)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    score,
    grade,
    scoreBreakdown: Object.fromEntries(
      Object.entries(breakdown).map(([k, v]) => [k, Math.round(v * 100) / 100]),
    ),
    locAdded: totalLocAdded,
    locRemoved: totalLocRemoved,
    languages: languageTotals,
    commandMix,
    testShare: totalCommands ? (commandTotals.test ?? 0) / totalCommands : 0,
    outcomes,
    concludedSessions,
    agenticity: median(agenticities),
    longestRun,
    delegationCalls: totalDelegation,
    redGreenCycles: totalRedGreen,
    verifiedEditCycles: totalCycles,
    skills: [...allSkills].sort(),
    mcpServers: [...allMcp].sort(),
    backgroundTasks: totalBackground,
    maxConcurrentSessions: maxConcurrent(rows),
  }
}

// ---------- Achievements ----------
// Computed openly from enclave-signed session facts. Every rule is a plain
// predicate over the same rows anyone can fetch — no hidden scoring.

interface Derived {
  rows: SessionRow[]
  repositories: number
  distinctTools: Set<string>
  models: Set<string>
  harnesses: Set<string>
  totalOutput: number
  longestSessionHours: number
  maxToolCallsInSession: number
  longestStreakDays: number
  usedSubagents: boolean
  locAdded: number
  languagesOver100: number
  gitCommands: number
  testCommands: number
  longestRun: number
  concludedSessions: number
  redGreenCycles: number
  distinctSkills: number
  maxConcurrent: number
}

function derive(rows: SessionRow[]): Derived {
  const repos = new Set<string>()
  const distinctTools = new Set<string>()
  const models = new Set<string>()
  const harnesses = new Set<string>()
  let totalOutput = 0
  let longestSessionHours = 0
  let maxToolCallsInSession = 0
  let usedSubagents = false
  const days = new Set<string>()

  let locAdded = 0
  const languageTotals: Record<string, number> = {}
  const commandTotals: Record<string, number> = {}
  const outcomes: Record<string, number> = {}
  let longestRun = 0
  let redGreenCycles = 0
  const distinctSkills = new Set<string>()

  for (const r of rows) {
    if (r.project_hash) repos.add(r.project_hash)
    harnesses.add(r.harness)
    totalOutput += r.output_tokens
    maxToolCallsInSession = Math.max(maxToolCallsInSession, r.tool_call_count)
    for (const m of JSON.parse(r.models || '[]') as string[]) models.add(m)
    for (const name of Object.keys(JSON.parse(r.tool_counts || '{}') as Record<string, number>)) {
      distinctTools.add(name)
      if (/^(agent|task|workflow)/i.test(name)) usedSubagents = true
    }
    if (r.started_at && r.ended_at) {
      longestSessionHours = Math.max(
        longestSessionHours,
        (Date.parse(r.ended_at) - Date.parse(r.started_at)) / 3_600_000,
      )
    }
    if (r.started_at) days.add(r.started_at.slice(0, 10))
    if (r.ended_at) days.add(r.ended_at.slice(0, 10))

    locAdded += r.loc_added ?? 0
    for (const [k, v] of Object.entries(JSON.parse(r.languages || '{}') as Record<string, number>)) {
      languageTotals[k] = (languageTotals[k] ?? 0) + v
    }
    for (const [k, v] of Object.entries(JSON.parse(r.command_counts || '{}') as Record<string, number>)) {
      commandTotals[k] = (commandTotals[k] ?? 0) + v
    }
    if (r.outcome) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1
    longestRun = Math.max(longestRun, r.longest_run ?? 0)
    redGreenCycles += r.red_green_cycles ?? 0
    for (const sk of JSON.parse(r.skills || '[]') as string[]) distinctSkills.add(sk)
  }

  const languagesOver100 = Object.values(languageTotals).filter((v) => v >= 100).length
  const gitCommands = commandTotals.git ?? 0
  const testCommands = commandTotals.test ?? 0
  const concludedSessions = (outcomes.shipped ?? 0) + (outcomes.landed ?? 0)

  let longestStreakDays = 0
  const sorted = [...days].sort()
  let run = 0
  let prev: string | null = null
  for (const day of sorted) {
    run = prev && Date.parse(day) - Date.parse(prev) === 86_400_000 ? run + 1 : 1
    longestStreakDays = Math.max(longestStreakDays, run)
    prev = day
  }

  return {
    rows,
    repositories: repos.size,
    distinctTools,
    models,
    harnesses,
    totalOutput,
    longestSessionHours,
    maxToolCallsInSession,
    longestStreakDays,
    usedSubagents,
    locAdded,
    languagesOver100,
    gitCommands,
    testCommands,
    longestRun,
    concludedSessions,
    redGreenCycles,
    distinctSkills: distinctSkills.size,
    maxConcurrent: maxConcurrent(rows),
  }
}

function tiered(
  id: string,
  name: string,
  description: string,
  current: number,
  target: number,
): Achievement {
  return {
    id,
    name,
    description,
    earned: current >= target,
    progress: current >= target ? null : { current, target },
  }
}

export function computeAchievements(d: Derived): Achievement[] {
  return [
    tiered('dual-wielder', 'Dual Wielder', 'Verified sessions from two different harnesses', d.harnesses.size, 2),
    tiered('repo-scout', 'Repo Scout', 'Sessions across 3 distinct repositories', d.repositories, 3),
    tiered('repo-hopper', 'Repo Hopper', 'Sessions across 8 distinct repositories', d.repositories, 8),
    tiered('toolsmith', 'Toolsmith', '12 distinct tools put to work', d.distinctTools.size, 12),
    tiered('model-polyglot', 'Model Polyglot', 'Sessions with 3 different models', d.models.size, 3),
    tiered('marathoner', 'Marathoner', 'A single session lasting 6+ hours', Math.floor(d.longestSessionHours), 6),
    tiered('centurion', 'Centurion', '100 tool calls in a single session', d.maxToolCallsInSession, 100),
    tiered('million-club', 'Million Token Club', '1M output tokens across all sessions', d.totalOutput, 1_000_000),
    tiered('week-streak', 'Week Streak', 'Active 7 days in a row', d.longestStreakDays, 7),
    {
      id: 'delegator',
      name: 'Delegator',
      description: 'Put subagents to work (Agent, Task, or Workflow tools)',
      earned: d.usedSubagents,
      progress: null,
    },
    tiered('collector', 'Collector', '25 verified sessions on the ledger', d.rows.length, 25),
    tiered('polyglot', 'Polyglot', '5 languages with 100+ lines each', d.languagesOver100, 5),
    tiered('ten-thousand-lines', 'Ten Thousand Lines', '10,000 lines of code added', d.locAdded, 10_000),
    tiered('git-native', 'Git Native', '250 git commands executed', d.gitCommands, 250),
    tiered('test-runner', 'Test Runner', '100 test commands executed', d.testCommands, 100),
    tiered('full-auto', 'Full Auto', 'A 100+ tool-call autonomous run', d.longestRun, 100),
    tiered('shipper', 'Shipper', '25 sessions shipped or landed', d.concludedSessions, 25),
    tiered('debugger', 'Debugger', '25 red-to-green fix cycles', d.redGreenCycles, 25),
    tiered('skillful', 'Skillful', '10 distinct skills invoked', d.distinctSkills, 10),
    tiered('multitasker', 'Multitasker', '3 sessions running at once', d.maxConcurrent, 3),
  ]
}

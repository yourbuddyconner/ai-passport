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
}

const GRADES: Array<[number, string]> = [
  [80, 'AI-Native'],
  [55, 'Power User'],
  [30, 'Practitioner'],
  [0, 'Novice'],
]

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
  }

  const derived = derive(rows)
  const distinctTools = Object.keys(toolTotals).length
  // Transparent 0-100 score: capped log-ish contributions per dimension.
  const breakdown = {
    volume: Math.min(25, rows.length * 2.5),
    toolBreadth: Math.min(25, distinctTools * 2.5),
    multiHarness: harnesses.size >= 2 ? 15 : 0,
    output: Math.min(20, totalOutput / 50_000),
    consistency: Math.min(15, days.size * 1.5),
  }
  const score = Math.round(
    Object.values(breakdown).reduce((a, b) => a + b, 0),
  )
  const grade = GRADES.find(([min]) => score >= min)![1]

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
      Object.entries(breakdown).map(([k, v]) => [k, Math.round(v * 10) / 10]),
    ),
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
  }

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
  ]
}

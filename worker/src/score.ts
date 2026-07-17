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
}

export interface CardData {
  totalSessions: number
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

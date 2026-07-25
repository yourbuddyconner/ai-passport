import { aggregate, gradeForScore, type SessionRow } from './score'

/** Score over an already-filtered (enclave-verified) row set. */
export function computeVerifiedScore(rows: SessionRow[]): number {
  if (rows.length === 0) return 0
  return Math.round(aggregate(rows).score)
}

const SESSION_COLUMNS = `harness, started_at, ended_at, message_count, tool_call_count,
  input_tokens, output_tokens, models, tool_counts, project_hash, loc_added, loc_removed,
  languages, command_counts, human_turns, agenticity, longest_run, parallel_batches,
  delegation_calls, verified_edit_cycles, red_green_cycles, outcome, skills, mcp_servers,
  background_tasks`

export async function recomputeVerifiedScore(db: D1Database, passportId: string): Promise<number> {
  const { results } = await db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE passport_id = ? AND verification = 'enclave'`)
    .bind(passportId)
    .all<SessionRow>()
  const score = computeVerifiedScore(results ?? [])
  await db.prepare('UPDATE passports SET verified_score = ? WHERE id = ?').bind(score, passportId).run()
  return score
}

// ---------- Leaderboard ranking (pure) ----------

/** One listed passport's aggregate stats over its enclave-verified sessions. */
export interface LeaderboardRow {
  slug: string
  name: string
  verifiedScore: number
  createdAt: string
  sessions: number
  locAdded: number
  concludedSessions: number
}

export interface LeaderboardEntry extends LeaderboardRow {
  rank: number
  grade: string
}

export interface Spotlight {
  slug: string
  name: string
  value: number
}

/**
 * Ranks listed passports by verified_score desc, created_at asc — the same
 * order the leaderboard SQL is written to produce. Rows with zero verified
 * sessions are excluded as a defense-in-depth measure even though the
 * caller's query should already filter them via JOIN/EXISTS.
 */
export function rankEntries(rows: LeaderboardRow[]): LeaderboardEntry[] {
  const eligible = rows.filter((r) => r.sessions > 0)
  const sorted = [...eligible].sort(
    (a, b) => b.verifiedScore - a.verifiedScore || a.createdAt.localeCompare(b.createdAt),
  )
  return sorted.map((r, i) => ({ ...r, rank: i + 1, grade: gradeForScore(r.verifiedScore) }))
}

function maxBy<T>(items: T[], key: (item: T) => number): T | null {
  let best: T | null = null
  for (const item of items) {
    if (best === null || key(item) > key(best)) best = item
  }
  return best
}

function spotlightOf(entry: LeaderboardEntry, value: number): Spotlight {
  return { slug: entry.slug, name: entry.name, value }
}

/**
 * Two spotlight winners, guaranteed distinct: the linesShipped leader, then
 * the concludedSessions leader among everyone else. Null when no entry has
 * a positive value for that metric (or there are no entries at all).
 */
export function pickSpotlights(entries: LeaderboardEntry[]): {
  linesShipped: Spotlight | null
  concluded: Spotlight | null
} {
  if (entries.length === 0) return { linesShipped: null, concluded: null }

  const topLoc = maxBy(entries, (e) => e.locAdded)
  const linesShipped = topLoc && topLoc.locAdded > 0 ? spotlightOf(topLoc, topLoc.locAdded) : null

  const concludedPool = linesShipped ? entries.filter((e) => e.slug !== linesShipped.slug) : entries
  const topConcluded = concludedPool.length ? maxBy(concludedPool, (e) => e.concludedSessions) : null
  const concluded =
    topConcluded && topConcluded.concludedSessions > 0
      ? spotlightOf(topConcluded, topConcluded.concludedSessions)
      : null

  return { linesShipped, concluded }
}

/** Small-N shielding: don't expose a public global rank until the pool is big enough. */
export function includeGlobalRank(listedCount: number): boolean {
  return listedCount >= 25
}

/**
 * Where a not-yet-listed passport would land if it opted in right now, given
 * the current ranked (listed) entries. Ties go after existing entries — a
 * newly-listed passport's created_at is later than anything already ranked,
 * matching the created_at ASC tie-break used by rankEntries.
 */
export function rankIfListed(entries: LeaderboardEntry[], hypotheticalScore: number): number {
  const ahead = entries.filter((e) => e.verifiedScore >= hypotheticalScore).length
  return ahead + 1
}

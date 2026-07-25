import { aggregate, type SessionRow } from './score'

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

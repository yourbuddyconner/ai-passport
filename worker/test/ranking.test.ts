import { describe, expect, it } from 'vitest'
import { computeVerifiedScore } from '../src/ranking'
import type { SessionRow } from '../src/score'

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    harness: 'claude-code',
    started_at: '2026-07-01T10:00:00Z',
    ended_at: '2026-07-01T12:00:00Z',
    message_count: 10,
    tool_call_count: 20,
    input_tokens: 1000,
    output_tokens: 2000,
    models: '["claude-fable-5"]',
    tool_counts: '{"Bash": 10, "Edit": 5}',
    project_hash: 'abc',
    loc_added: 0, loc_removed: 0, languages: '{}', command_counts: '{}',
    human_turns: 0, agenticity: 0, longest_run: 0, parallel_batches: 0,
    delegation_calls: 0, verified_edit_cycles: 0, red_green_cycles: 0,
    outcome: '', skills: '[]', mcp_servers: '[]', background_tasks: 0,
    ...over,
  }
}

describe('computeVerifiedScore', () => {
  it('scores only what it is given and rounds', () => {
    const rows: SessionRow[] = [row({ output_tokens: 10_000_000, loc_added: 5000, outcome: 'shipped' })]
    const s = computeVerifiedScore(rows)
    expect(Number.isInteger(s)).toBe(true)
    expect(s).toBeGreaterThan(0)
  })

  it('zero rows → zero', () => expect(computeVerifiedScore([])).toBe(0))
})

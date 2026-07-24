import { describe, expect, it } from 'vitest'
import { aggregate, type SessionRow } from '../src/score'

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

describe('score v2', () => {
  it('dimension maxes sum to 100 and clamp', () => {
    const rows = Array.from({ length: 20000 }, (_, i) =>
      row({
        harness: i % 2 ? 'codex' : 'claude-code',
        started_at: `2026-0${(i % 6) + 1}-01T10:00:00Z`,
        output_tokens: 10_000_000_000,
        loc_added: 10_000, outcome: 'shipped',
        verified_edit_cycles: 5, delegation_calls: 5,
      }),
    )
    const card = aggregate(rows)
    expect(card.score).toBeLessThanOrEqual(100)
    const sum = Object.values(card.scoreBreakdown).reduce((a, b) => a + b, 0)
    expect(Math.round(sum)).toBe(card.score)
  })

  it('log curves: 10x output tokens ≈ +2.5 within output dimension', () => {
    const a = aggregate([row({ output_tokens: 1_000_000 })])
    const b = aggregate([row({ output_tokens: 10_000_000 })])
    expect(b.scoreBreakdown.output - a.scoreBreakdown.output).toBeCloseTo(1.67, 1) // 10/6 per decade
  })

  it('zero sessions in new dimensions score zero, not NaN', () => {
    const card = aggregate([row()])
    expect(card.scoreBreakdown.codeShipped).toBe(0)
    expect(card.scoreBreakdown.concluded).toBe(0)
    expect(Number.isFinite(card.score)).toBe(true)
  })

  it('aggregates languages, outcomes, command mix, test share', () => {
    const card = aggregate([
      row({ languages: '{"ts": 100, "rs": 50}', command_counts: '{"test": 3, "git": 7}',
            outcome: 'shipped', loc_added: 150, loc_removed: 10 }),
      row({ languages: '{"ts": 40}', command_counts: '{"other": 10}', outcome: 'research' }),
    ])
    expect(card.languages).toEqual({ ts: 140, rs: 50 })
    expect(card.outcomes).toEqual({ shipped: 1, research: 1 })
    expect(card.concludedSessions).toBe(1)
    expect(card.testShare).toBeCloseTo(0.15, 5) // 3 of 20
    expect(card.locAdded).toBe(150)
  })

  it('computes max concurrent sessions from overlapping windows', () => {
    const card = aggregate([
      row({ started_at: '2026-07-01T10:00:00Z', ended_at: '2026-07-01T12:00:00Z' }),
      row({ started_at: '2026-07-01T11:00:00Z', ended_at: '2026-07-01T13:00:00Z' }),
      row({ started_at: '2026-07-01T11:30:00Z', ended_at: '2026-07-01T11:45:00Z' }),
      row({ started_at: '2026-07-02T10:00:00Z', ended_at: '2026-07-02T11:00:00Z' }),
    ])
    expect(card.maxConcurrentSessions).toBe(3)
  })

  it('agenticity is the median of session medians', () => {
    const card = aggregate([row({ agenticity: 2 }), row({ agenticity: 6 }), row({ agenticity: 10 })])
    expect(card.agenticity).toBe(6)
  })
})

describe('achievements v2', () => {
  it('polyglot needs 5 languages with 100+ lines each', () => {
    const card = aggregate([row({
      languages: '{"ts":150,"rs":120,"py":100,"go":100,"sql":100,"md":50}',
    })])
    const a = card.achievements.find((x) => x.id === 'polyglot')!
    expect(a.earned).toBe(true)
  })
  it('shipper counts shipped + landed', () => {
    const rows = [
      ...Array.from({ length: 20 }, () => row({ outcome: 'shipped' })),
      ...Array.from({ length: 5 }, () => row({ outcome: 'landed' })),
    ]
    expect(aggregate(rows).achievements.find((x) => x.id === 'shipper')!.earned).toBe(true)
  })
  it('multitasker needs 3 concurrent sessions', () => {
    const card = aggregate([
      row({ started_at: '2026-07-01T10:00:00Z', ended_at: '2026-07-01T12:00:00Z' }),
      row({ started_at: '2026-07-01T10:30:00Z', ended_at: '2026-07-01T12:30:00Z' }),
      row({ started_at: '2026-07-01T11:00:00Z', ended_at: '2026-07-01T11:30:00Z' }),
    ])
    expect(card.achievements.find((x) => x.id === 'multitasker')!.earned).toBe(true)
  })
})

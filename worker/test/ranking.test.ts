import { describe, expect, it } from 'vitest'
import {
  computeVerifiedScore,
  includeGlobalRank,
  isLastMember,
  ladderLimitReached,
  makeInviteCode,
  pickSpotlights,
  rankEntries,
  rankIfListed,
  validateLadderName,
  type LeaderboardRow,
} from '../src/ranking'
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

function ladderRow(over: Partial<LeaderboardRow> = {}): LeaderboardRow {
  return {
    slug: 'alpha',
    name: 'Alpha',
    verifiedScore: 50,
    createdAt: '2026-01-01T00:00:00Z',
    sessions: 1,
    locAdded: 0,
    concludedSessions: 0,
    ...over,
  }
}

describe('rankEntries', () => {
  it('orders by score desc, then created_at asc on ties', () => {
    const rows = [
      ladderRow({ slug: 'low', verifiedScore: 10, createdAt: '2026-01-01T00:00:00Z' }),
      ladderRow({ slug: 'tie-later', verifiedScore: 40, createdAt: '2026-02-01T00:00:00Z' }),
      ladderRow({ slug: 'high', verifiedScore: 90, createdAt: '2026-03-01T00:00:00Z' }),
      ladderRow({ slug: 'tie-earlier', verifiedScore: 40, createdAt: '2026-01-15T00:00:00Z' }),
    ]
    const ranked = rankEntries(rows)
    expect(ranked.map((r) => r.slug)).toEqual(['high', 'tie-earlier', 'tie-later', 'low'])
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3, 4])
  })

  it('excludes passports with zero verified sessions', () => {
    const rows = [
      ladderRow({ slug: 'has-sessions', sessions: 3, verifiedScore: 10 }),
      ladderRow({ slug: 'no-sessions', sessions: 0, verifiedScore: 90 }),
    ]
    const ranked = rankEntries(rows)
    expect(ranked.map((r) => r.slug)).toEqual(['has-sessions'])
  })

  it('assigns a grade from the score', () => {
    const ranked = rankEntries([ladderRow({ verifiedScore: 85 })])
    expect(ranked[0].grade).toBe('AI-Native')
  })
})

describe('pickSpotlights', () => {
  it('picks distinct winners when one slug leads both metrics', () => {
    const entries = rankEntries([
      ladderRow({ slug: 'dominant', verifiedScore: 90, locAdded: 5000, concludedSessions: 20 }),
      ladderRow({ slug: 'runner-up', verifiedScore: 80, locAdded: 1000, concludedSessions: 15 }),
    ])
    const spotlights = pickSpotlights(entries)
    expect(spotlights.linesShipped?.slug).toBe('dominant')
    expect(spotlights.concluded?.slug).toBe('runner-up')
  })

  it('returns null spotlights when there are no eligible entries', () => {
    expect(pickSpotlights([])).toEqual({ linesShipped: null, concluded: null })
  })

  it('returns null for a metric with no eligible (all-zero) values', () => {
    const entries = rankEntries([
      ladderRow({ slug: 'only', verifiedScore: 50, locAdded: 0, concludedSessions: 0 }),
    ])
    const spotlights = pickSpotlights(entries)
    expect(spotlights.linesShipped).toBeNull()
    expect(spotlights.concluded).toBeNull()
  })
})

describe('includeGlobalRank', () => {
  it('is false below the floor of 25', () => {
    expect(includeGlobalRank(24)).toBe(false)
  })
  it('is true at and above the floor', () => {
    expect(includeGlobalRank(25)).toBe(true)
    expect(includeGlobalRank(26)).toBe(true)
  })
})

describe('rankIfListed', () => {
  it('inserts after equal scores (created_at asc semantics for a new passport)', () => {
    const rows = [
      ladderRow({ slug: 'a', verifiedScore: 90 }),
      ladderRow({ slug: 'b', verifiedScore: 50 }),
      ladderRow({ slug: 'c', verifiedScore: 50 }),
      ladderRow({ slug: 'd', verifiedScore: 10 }),
    ]
    const ranked = rankEntries(rows)
    // Hypothetical score ties with b/c (50): a new passport lands after both.
    expect(rankIfListed(ranked, 50)).toBe(4)
    // Beats everyone.
    expect(rankIfListed(ranked, 100)).toBe(1)
    // Below everyone.
    expect(rankIfListed(ranked, 0)).toBe(5)
  })
})

describe('validateLadderName', () => {
  it('trims whitespace', () => {
    expect(validateLadderName('  Team Alpha  ')).toBe('Team Alpha')
  })

  it('rejects empty (post-trim) names', () => {
    expect(validateLadderName('')).toBeNull()
    expect(validateLadderName('   ')).toBeNull()
  })

  it('rejects names over 64 characters', () => {
    expect(validateLadderName('a'.repeat(64))).toBe('a'.repeat(64))
    expect(validateLadderName('a'.repeat(65))).toBeNull()
  })

  it('rejects non-string input', () => {
    expect(validateLadderName(undefined)).toBeNull()
    expect(validateLadderName(42)).toBeNull()
  })
})

describe('ladderLimitReached', () => {
  it('is false below the cap of 5', () => {
    expect(ladderLimitReached(0)).toBe(false)
    expect(ladderLimitReached(4)).toBe(false)
  })

  it('is true at and above the cap', () => {
    expect(ladderLimitReached(5)).toBe(true)
    expect(ladderLimitReached(6)).toBe(true)
  })
})

describe('makeInviteCode', () => {
  it('produces 32 lowercase hex characters', () => {
    const code = makeInviteCode()
    expect(code).toMatch(/^[0-9a-f]{32}$/)
  })

  it('is not deterministic across calls', () => {
    expect(makeInviteCode()).not.toBe(makeInviteCode())
  })
})

describe('isLastMember', () => {
  it('is true when the pre-leave count is 1 or fewer', () => {
    expect(isLastMember(1)).toBe(true)
    expect(isLastMember(0)).toBe(true)
  })

  it('is false when other members remain after the leave', () => {
    expect(isLastMember(2)).toBe(false)
    expect(isLastMember(5)).toBe(false)
  })
})

describe('ladder entries + pending (via rankEntries)', () => {
  it('excludes zero-verified members, leaving them countable as pending', () => {
    const rows = [
      ladderRow({ slug: 'verified', sessions: 2, verifiedScore: 40 }),
      ladderRow({ slug: 'pending-1', sessions: 0, verifiedScore: 0 }),
      ladderRow({ slug: 'pending-2', sessions: 0, verifiedScore: 0 }),
    ]
    const entries = rankEntries(rows)
    expect(entries.map((e) => e.slug)).toEqual(['verified'])
    const totalMembers = rows.length
    const pending = totalMembers - entries.length
    expect(pending).toBe(2)
  })
})

import { describe, it, expect } from 'vitest'
import { parseTrace, ParseError } from '../src/parsers'
import { aggregate } from '../src/score'

const claudeTrace = [
  {
    type: 'user',
    sessionId: 'abc-123',
    timestamp: '2026-07-10T15:15:45.972Z',
    message: { role: 'user', content: 'hello' },
  },
  {
    type: 'assistant',
    sessionId: 'abc-123',
    timestamp: '2026-07-10T15:16:00.000Z',
    message: {
      model: 'claude-opus-4-8',
      usage: { input_tokens: 100, output_tokens: 250 },
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', name: 'Bash', input: {} },
      ],
    },
  },
  {
    type: 'assistant',
    sessionId: 'abc-123',
    timestamp: '2026-07-10T16:00:00.000Z',
    message: {
      model: 'claude-opus-4-8',
      usage: { input_tokens: 50, output_tokens: 75 },
      content: [{ type: 'tool_use', name: 'Read', input: {} }],
    },
  },
  { type: 'file-history-snapshot', sessionId: 'abc-123' },
]
  .map((o) => JSON.stringify(o))
  .join('\n')

const codexTrace = [
  {
    timestamp: '2026-05-28T04:51:39.284Z',
    type: 'session_meta',
    payload: { id: 'codex-session-1', cwd: '/x', originator: 'codex_exec' },
  },
  {
    timestamp: '2026-05-28T04:51:40.000Z',
    type: 'turn_context',
    payload: { model: 'gpt-5.4' },
  },
  {
    timestamp: '2026-05-28T04:52:00.000Z',
    type: 'response_item',
    payload: { type: 'function_call', name: 'exec_command', arguments: '{}' },
  },
  {
    timestamp: '2026-05-28T04:53:00.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'assistant' },
  },
  {
    timestamp: '2026-05-28T04:55:57.216Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 780470, output_tokens: 13366 } },
    },
  },
]
  .map((o) => JSON.stringify(o))
  .join('\n')

describe('parseTrace: claude-code', () => {
  it('parses a claude code trace', () => {
    const s = parseTrace(claudeTrace)
    expect(s.harness).toBe('claude-code')
    expect(s.externalId).toBe('abc-123')
    expect(s.messageCount).toBe(3)
    expect(s.toolCallCount).toBe(2)
    expect(s.inputTokens).toBe(150)
    expect(s.outputTokens).toBe(325)
    expect(s.models).toEqual(['claude-opus-4-8'])
    expect(s.toolCounts).toEqual({ Bash: 1, Read: 1 })
    expect(s.startedAt).toBe('2026-07-10T15:15:45.972Z')
    expect(s.endedAt).toBe('2026-07-10T16:00:00.000Z')
  })
})

describe('parseTrace: codex', () => {
  it('parses a codex trace', () => {
    const s = parseTrace(codexTrace)
    expect(s.harness).toBe('codex')
    expect(s.externalId).toBe('codex-session-1')
    expect(s.messageCount).toBe(1)
    expect(s.toolCallCount).toBe(1)
    expect(s.inputTokens).toBe(780470)
    expect(s.outputTokens).toBe(13366)
    expect(s.models).toEqual(['gpt-5.4'])
    expect(s.toolCounts).toEqual({ exec_command: 1 })
  })
})

describe('parseTrace: errors', () => {
  it('rejects empty input', () => {
    expect(() => parseTrace('')).toThrow(ParseError)
  })
  it('rejects non-JSONL', () => {
    expect(() => parseTrace('hello world\nnot json')).toThrow(ParseError)
  })
  it('rejects unrecognized JSONL', () => {
    expect(() => parseTrace('{"foo": 1}\n{"bar": 2}')).toThrow(/Unrecognized/)
  })
  it('tolerates corrupt lines inside a valid trace', () => {
    const s = parseTrace(claudeTrace + '\n{broken json')
    expect(s.externalId).toBe('abc-123')
  })
})

describe('aggregate', () => {
  it('aggregates sessions into card data', () => {
    const claude = parseTrace(claudeTrace)
    const codex = parseTrace(codexTrace)
    const rows = [claude, codex].map((s) => ({
      harness: s.harness,
      started_at: s.startedAt,
      ended_at: s.endedAt,
      message_count: s.messageCount,
      tool_call_count: s.toolCallCount,
      input_tokens: s.inputTokens,
      output_tokens: s.outputTokens,
      models: JSON.stringify(s.models),
      tool_counts: JSON.stringify(s.toolCounts),
    }))
    const card = aggregate(rows)
    expect(card.totalSessions).toBe(2)
    expect(card.harnesses.sort()).toEqual(['claude-code', 'codex'])
    expect(card.models).toContain('gpt-5.4')
    expect(card.scoreBreakdown.multiHarness).toBe(15)
    expect(card.score).toBeGreaterThan(0)
    expect(card.score).toBeLessThanOrEqual(100)
    expect(card.grade).toBeTruthy()
    expect(card.activeDays).toBe(2)
    expect(card.topTools[0]).toBeDefined()
  })
})

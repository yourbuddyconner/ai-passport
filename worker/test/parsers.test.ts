import { describe, it, expect } from 'vitest'
import { parseTrace, ParseError } from '../src/parsers'
import { parseClaudeCode } from '../src/parsers/claudeCode'
import { parseCodex } from '../src/parsers/codex'
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

describe('claude code v2 metrics', () => {
  const L = (o: object) => o
  const lines = [
    L({ type: 'user', sessionId: 's1', cwd: '/repo', timestamp: '2026-07-01T10:00:00Z',
        message: { content: 'add a feature' } }),
    // parallel batch: two tool_use sharing a requestId
    L({ type: 'assistant', sessionId: 's1', requestId: 'r1', timestamp: '2026-07-01T10:00:05Z',
        message: { model: 'claude-fable-5', usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/src/a.ts' } }] } }),
    L({ type: 'assistant', sessionId: 's1', requestId: 'r1',
        message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash',
          input: { command: 'cd worker && npx vitest run' } }] } }),
    // failing test result (red)
    L({ type: 'user', sessionId: 's1', message: { content: [
        { type: 'tool_result', tool_use_id: 't2', is_error: true }] } }),
    // edit via Write (create): 3 lines
    L({ type: 'assistant', sessionId: 's1', requestId: 'r2',
        message: { content: [{ type: 'tool_use', id: 't3', name: 'Write',
          input: { file_path: '/repo/src/a.ts', content: 'a\nb\nc' } }] } }),
    L({ type: 'user', sessionId: 's1', toolUseResult: { type: 'create', filePath: '/repo/src/a.ts',
        content: 'a\nb\nc', structuredPatch: [] },
        message: { content: [{ type: 'tool_result', tool_use_id: 't3' }] } }),
    // edit on generated path — excluded from LOC/languages
    L({ type: 'user', sessionId: 's1', toolUseResult: { type: 'create',
        filePath: '/repo/package-lock.json', content: 'x\n'.repeat(100), structuredPatch: [] },
        message: { content: [{ type: 'tool_result', tool_use_id: 't3b' }] } }),
    // Edit with structuredPatch: +2 -1 on a .tsx file (aliases to ts)
    L({ type: 'user', sessionId: 's1', toolUseResult: { filePath: '/repo/src/B.tsx',
        structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3,
          lines: [' keep', '+new1', '+new2', '-old'] }] },
        message: { content: [{ type: 'tool_result', tool_use_id: 't3c' }] } }),
    // passing test after edits (green + verified cycle + red→green cycle)
    L({ type: 'assistant', sessionId: 's1', requestId: 'r3',
        message: { content: [{ type: 'tool_use', id: 't4', name: 'Bash',
          input: { command: 'cd worker && npx vitest run', run_in_background: false } }] } }),
    L({ type: 'user', sessionId: 's1', message: { content: [
        { type: 'tool_result', tool_use_id: 't4', is_error: false }] } }),
    // commit then push → shipped
    L({ type: 'assistant', sessionId: 's1', requestId: 'r4',
        message: { content: [{ type: 'tool_use', id: 't5', name: 'Bash',
          input: { command: 'git add -A && git commit -m "feat"' } }] } }),
    L({ type: 'user', sessionId: 's1', message: { content: [
        { type: 'tool_result', tool_use_id: 't5' }] } }),
    L({ type: 'assistant', sessionId: 's1', requestId: 'r5',
        message: { content: [{ type: 'tool_use', id: 't6', name: 'Bash',
          input: { command: 'git push origin main', run_in_background: true } }] } }),
    L({ type: 'user', sessionId: 's1', message: { content: [
        { type: 'tool_result', tool_use_id: 't6' }] } }),
    // second human turn, then delegation + skill + mcp
    L({ type: 'user', sessionId: 's1', message: { content: 'now polish it' } }),
    L({ type: 'assistant', sessionId: 's1', requestId: 'r6',
        message: { content: [{ type: 'tool_use', id: 't7', name: 'Agent',
          input: { prompt: 'x', description: 'y' } }] } }),
    L({ type: 'assistant', sessionId: 's1', requestId: 'r7',
        message: { content: [{ type: 'tool_use', id: 't8', name: 'Skill',
          input: { skill: 'dataviz' } }] } }),
    L({ type: 'assistant', sessionId: 's1', requestId: 'r8', attributionMcpServer: 'claude-in-chrome',
        message: { content: [{ type: 'tool_use', id: 't9',
          name: 'mcp__claude-in-chrome__navigate', input: { url: 'x' } }] } }),
    // meta and sidechain lines must not count as human turns or main-chain calls
    L({ type: 'user', sessionId: 's1', isMeta: true, message: { content: 'injected' } }),
    L({ type: 'user', sessionId: 's1', message: { content: '<system-reminder>noise' } }),
    L({ type: 'assistant', sessionId: 's1', isSidechain: true,
        message: { content: [{ type: 'tool_use', id: 't10', name: 'Read', input: {} }] } }),
  ]

  it('extracts v2 metrics', () => {
    const s = parseClaudeCode(lines)
    expect(s.locAdded).toBe(5)            // 3 (create) + 2 (patch); lockfile excluded
    expect(s.locRemoved).toBe(1)
    expect(s.languages).toEqual({ ts: 6 }) // 3 + (2+1) on .ts/.tsx
    expect(s.commandCounts).toEqual({ test: 2, git: 2 })
    expect(s.humanTurns).toBe(2)
    expect(s.longestRun).toBe(6)          // t1..t6 before second human turn
    expect(s.agenticity).toBe(4.5)        // runs [6, 3] → median 4.5
    expect(s.parallelBatches).toBe(1)     // r1 has two tool_use
    expect(s.delegationCalls).toBe(1)
    expect(s.verifiedEditCycles).toBe(1)
    expect(s.redGreenCycles).toBe(1)      // fail t2 → edits → pass t4
    expect(s.outcome).toBe('shipped')
    expect(s.skills).toEqual(['dataviz'])
    expect(s.mcpServers).toEqual(['claude-in-chrome'])
    expect(s.backgroundTasks).toBe(1)     // t6 run_in_background
  })

  it('zeroes v2 metrics on minimal traces', () => {
    const s = parseClaudeCode([
      { type: 'user', sessionId: 's2', message: { content: 'hi' } },
      { type: 'assistant', sessionId: 's2', message: { model: 'claude-fable-5', content: [] } },
    ])
    expect(s.locAdded).toBe(0)
    expect(s.outcome).toBe('trivial')
    expect(s.skills).toEqual([])
  })

  it('ignores sidechain attribution and trims trailing newlines', () => {
    const s = parseClaudeCode([
      { type: 'user', sessionId: 's3', message: { content: 'go' } },
      { type: 'system', sessionId: 's3', isSidechain: true, attributionSkill: 'sneaky',
        attributionMcpServer: 'sneaky-server' },
      { type: 'assistant', sessionId: 's3',
        message: { content: [{ type: 'tool_use', id: 'w1', name: 'Write',
          input: { file_path: '/repo/x.py', content: 'a\nb\n' } }] } },
      { type: 'user', sessionId: 's3', toolUseResult: { type: 'create', filePath: '/repo/x.py',
        content: 'a\nb\n', structuredPatch: [] },
        message: { content: [{ type: 'tool_result', tool_use_id: 'w1' }] } },
    ])
    expect(s.skills).toEqual([])
    expect(s.mcpServers).toEqual([])
    expect(s.locAdded).toBe(2)
  })
})

describe('codex v2 metrics', () => {
  const PATCH = [
    '*** Begin Patch',
    '*** Update File: /repo/src/main.py',
    '@@',
    ' context',
    '+added line one',
    '+added line two',
    '-removed line',
    '*** End Patch',
  ].join('\n')
  const lines = [
    { type: 'session_meta', timestamp: '2026-07-01T09:00:00Z', payload: { id: 'c1', cwd: '/repo' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'fix the bug' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'x1',
        arguments: JSON.stringify({ cmd: 'pytest -x' }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'x1',
        output: 'Process exited with code 1\nFAILED' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'x2',
        input: PATCH } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'x2',
        output: '{"output":"Success","metadata":{"exit_code":0}}' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'x3',
        arguments: JSON.stringify({ cmd: 'pytest -x' }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'x3',
        output: 'Process exited with code 0\n2 passed' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'x4',
        arguments: JSON.stringify({ cmd: 'git add -A && git commit -m fix' }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'x4',
        output: 'Process exited with code 0' } },
    { type: 'response_item', payload: { type: 'message', content: [{ type: 'output_text', text: 'done' }] } },
  ]

  it('extracts v2 metrics', () => {
    const s = parseCodex(lines)
    expect(s.locAdded).toBe(2)
    expect(s.locRemoved).toBe(1)
    expect(s.languages).toEqual({ py: 3 })
    expect(s.commandCounts).toEqual({ test: 2, git: 1 })
    expect(s.humanTurns).toBe(1)
    expect(s.verifiedEditCycles).toBe(1)
    expect(s.redGreenCycles).toBe(1)
    expect(s.outcome).toBe('landed')  // commit after last edit, green after first edit
    expect(s.agenticity).toBe(4)      // one run of 4 calls
    expect(s.longestRun).toBe(4)
    expect(s.delegationCalls).toBe(0)
    expect(s.skills).toEqual([])
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

import { describe, it, expect } from 'vitest'
import { canonicalizeTrace } from '../../web/src/lib/canonicalize'
import { parseClaudeCode } from '../src/parsers/claudeCode'
import { parseCodex } from '../src/parsers/codex'

function parseLines(text: string): unknown[] {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
}

const bigBase64Image = 'A'.repeat(5000)

// A Claude Code trace with a top-level image block on a user tool_result,
// a nested image block inside a tool_result.content array, and a
// toolUseResult of type 'image' carrying a base64 file payload.
const claudeCodeLines = [
  {
    type: 'user',
    sessionId: 'sess-abc',
    timestamp: '2026-07-10T15:15:45.972Z',
    message: { role: 'user', content: 'hello' },
  },
  {
    type: 'assistant',
    sessionId: 'sess-abc',
    timestamp: '2026-07-10T15:16:00.000Z',
    message: {
      model: 'claude-opus-4-8',
      usage: { input_tokens: 100, output_tokens: 250 },
      content: [
        { type: 'text', text: 'looking at the screenshot' },
        { type: 'tool_use', name: 'Bash', id: 'tu_1', input: { command: 'ls' } },
      ],
    },
  },
  {
    type: 'user',
    sessionId: 'sess-abc',
    timestamp: '2026-07-10T15:16:05.000Z',
    message: {
      role: 'user',
      content: [
        {
          tool_use_id: 'tu_1',
          type: 'tool_result',
          content: [
            { type: 'text', text: 'Successfully captured screenshot' },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: bigBase64Image } },
          ],
        },
      ],
    },
  },
  {
    type: 'user',
    sessionId: 'sess-abc',
    timestamp: '2026-07-10T15:16:10.000Z',
    message: { role: 'user', content: 'thanks' },
    toolUseResult: {
      type: 'image',
      file: {
        base64: bigBase64Image,
        type: 'image/png',
        originalSize: 74469,
        dimensions: { originalWidth: 1200, originalHeight: 630 },
      },
    },
  },
  { type: 'file-history-snapshot', sessionId: 'sess-abc' },
]
const claudeCodeTrace = claudeCodeLines.map((o) => JSON.stringify(o)).join('\n')

// A Codex trace with a compacted line carrying the session-max timestamp,
// plus a reasoning response_item and an agent_reasoning event_msg.
const codexLines = [
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
    timestamp: '2026-05-28T04:51:45.000Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: 'do the thing' },
  },
  {
    timestamp: '2026-05-28T04:52:00.000Z',
    type: 'response_item',
    payload: {
      type: 'reasoning',
      summary: [],
      encrypted_content: 'gAAAAA' + 'x'.repeat(2000),
    },
  },
  {
    timestamp: '2026-05-28T04:52:05.000Z',
    type: 'event_msg',
    payload: { type: 'agent_reasoning', text: '**Planning the fix**' + 'y'.repeat(2000) },
  },
  {
    timestamp: '2026-05-28T04:52:10.000Z',
    type: 'response_item',
    payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: '{"cmd":"echo hi"}' },
  },
  {
    timestamp: '2026-05-28T04:52:11.000Z',
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: 'c1', output: 'hi\nexited with code 0' },
  },
  // compacted line carries the max timestamp in the session
  {
    timestamp: '2026-06-01T00:00:00.000Z',
    type: 'compacted',
    payload: {
      message: '',
      replacement_history: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'z'.repeat(3000) }] },
      ],
    },
  },
]
const codexTrace = codexLines.map((o) => JSON.stringify(o)).join('\n')

describe('canonicalizeTrace', () => {
  it('produces stats-identical output for Claude Code traces (parity)', () => {
    const canonical = canonicalizeTrace(claudeCodeTrace)
    const before = parseClaudeCode(parseLines(claudeCodeTrace))
    const after = parseClaudeCode(parseLines(canonical))
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
  })

  it('produces stats-identical output for Codex traces, including endedAt from a compacted line (parity)', () => {
    const canonical = canonicalizeTrace(codexTrace)
    const before = parseCodex(parseLines(codexTrace))
    const after = parseCodex(parseLines(canonical))
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
    expect(before.endedAt).toBe('2026-06-01T00:00:00.000Z')
    expect(after.endedAt).toBe('2026-06-01T00:00:00.000Z')
  })

  it('shrinks Claude Code traces by stripping image payloads', () => {
    const canonical = canonicalizeTrace(claudeCodeTrace)
    expect(canonical.length).toBeLessThan(claudeCodeTrace.length)
    expect(canonical).not.toContain(bigBase64Image)
  })

  it('shrinks Codex traces by stripping compacted/reasoning payloads', () => {
    const canonical = canonicalizeTrace(codexTrace)
    expect(canonical.length).toBeLessThan(codexTrace.length)
    expect(canonical).not.toContain('replacement_history')
    expect(canonical).not.toContain('encrypted_content')
  })

  it('passes non-JSON lines through verbatim', () => {
    const text = 'not json at all\n{"type":"session_meta","payload":{"id":"x"}}\n<<< corrupt {'
    expect(canonicalizeTrace(text)).toBe(text)
  })

  it('passes unknown JSON shapes through verbatim', () => {
    const lines = [
      JSON.stringify({ foo: 'bar', nested: { baz: [1, 2, 3] } }),
      JSON.stringify([1, 2, 3]),
      JSON.stringify('a bare string'),
      JSON.stringify(42),
    ].join('\n')
    expect(canonicalizeTrace(lines)).toBe(lines)
  })

  it('handles empty input', () => {
    expect(canonicalizeTrace('')).toBe('')
  })

  it('preserves trailing newline presence', () => {
    const withNL = claudeCodeTrace + '\n'
    const withoutNL = claudeCodeTrace
    expect(canonicalizeTrace(withNL).endsWith('\n')).toBe(true)
    expect(canonicalizeTrace(withoutNL).endsWith('\n')).toBe(false)
  })
})

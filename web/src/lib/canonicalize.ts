/**
 * Strips parser-irrelevant bytes from a Claude Code / Codex JSONL trace
 * before it leaves the browser, without changing anything the worker's
 * parsers (`worker/src/parsers/claudeCode.ts`, `worker/src/parsers/codex.ts`)
 * read to compute session stats.
 *
 * What gets stripped:
 *  - Codex `compacted` lines (top-level `type: "compacted"`) are replaced
 *    with a minimal `{ type, timestamp }` stub. The parser only reads
 *    `timestamp` off these lines (for startedAt/endedAt); the bulky
 *    `payload.replacement_history` is never touched.
 *  - Codex reasoning lines — `response_item` payloads with
 *    `payload.type === "reasoning"` (encrypted_content + summary) and
 *    `event_msg` payloads with `payload.type === "agent_reasoning"`
 *    (free-text `text`) — are reduced to a `{ type, timestamp, payload:
 *    { type } }` shell. Neither payload type is read by parseCodex.
 *  - Claude Code image blocks: any `{ type: 'image', source: { data } }`
 *    block found anywhere inside a `message.content` block tree (including
 *    blocks nested inside `tool_result.content`) has `source.data` blanked.
 *  - Claude Code image tool results: `toolUseResult.type === 'image'` has
 *    its `file.base64` payload blanked. parseClaudeCode never reads
 *    `toolUseResult` unless it carries a `structuredPatch` array or
 *    `type === 'create'`, so image results are otherwise inert.
 *
 * Anything not matching these shapes — including entire lines that aren't
 * valid JSON, or JSON that isn't a plain object — passes through verbatim.
 */

type JSONObject = Record<string, unknown>

function isPlainObject(v: unknown): v is JSONObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Recursively blank `source.data` on any `{ type: 'image' }` content block. */
function stripImageBlock(block: unknown): unknown {
  if (Array.isArray(block)) return block.map(stripImageBlock)
  if (!isPlainObject(block)) return block

  if (block.type === 'image' && isPlainObject(block.source) && typeof block.source.data === 'string') {
    return { ...block, source: { ...block.source, data: '' } }
  }
  if (Array.isArray(block.content)) {
    return { ...block, content: block.content.map(stripImageBlock) }
  }
  return block
}

function canonicalizeClaudeLine(o: JSONObject): JSONObject {
  let out = o

  const message = out.message
  if (isPlainObject(message) && Array.isArray(message.content)) {
    out = { ...out, message: { ...message, content: message.content.map(stripImageBlock) } }
  }

  const toolUseResult = out.toolUseResult
  if (
    isPlainObject(toolUseResult) &&
    toolUseResult.type === 'image' &&
    isPlainObject(toolUseResult.file) &&
    typeof toolUseResult.file.base64 === 'string'
  ) {
    out = {
      ...out,
      toolUseResult: { ...toolUseResult, file: { ...toolUseResult.file, base64: '' } },
    }
  }

  return out
}

function codexReasoningStub(o: JSONObject): JSONObject | null {
  const payload = o.payload
  if (!isPlainObject(payload)) return null
  if (payload.type !== 'reasoning' && payload.type !== 'agent_reasoning') return null

  const stub: JSONObject = { type: o.type, payload: { type: payload.type } }
  if ('timestamp' in o) stub.timestamp = o.timestamp
  return stub
}

function canonicalizeCodexLine(o: JSONObject): JSONObject {
  if (o.type === 'compacted') {
    const stub: JSONObject = { type: o.type }
    if ('timestamp' in o) stub.timestamp = o.timestamp
    return stub
  }
  const reasoningStub = codexReasoningStub(o)
  if (reasoningStub) return reasoningStub
  return o
}

function canonicalizeValue(value: unknown): unknown {
  if (!isPlainObject(value)) return value
  // Both harnesses' irrelevant-payload shapes are structurally disjoint
  // (Claude Code lines never carry Codex's payload.type, and vice versa),
  // so applying both passes unconditionally is safe and avoids needing to
  // sniff which harness a line came from.
  return canonicalizeClaudeLine(canonicalizeCodexLine(value))
}

/**
 * Line-oriented canonicalization: non-JSON lines and lines whose parsed
 * shape doesn't match a known stripping rule pass through verbatim.
 * Trailing-newline presence is preserved.
 */
export function canonicalizeTrace(text: string): string {
  if (text === '') return text
  const lines = text.split('\n')
  const out = lines.map((line) => {
    if (line.trim() === '') return line
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return line
    }
    const canonicalized = canonicalizeValue(parsed)
    return JSON.stringify(canonicalized)
  })
  return out.join('\n')
}

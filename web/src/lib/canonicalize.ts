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

/** Recursively blank `source.data` on any `{ type: 'image' }` content block.
 * Returns [block, changed] where changed indicates if anything was stripped. */
function stripImageBlock(block: unknown): [unknown, boolean] {
  if (Array.isArray(block)) {
    let changed = false
    const result = block.map((b) => {
      const [stripped, blockChanged] = stripImageBlock(b)
      if (blockChanged) changed = true
      return stripped
    })
    return [result, changed]
  }
  if (!isPlainObject(block)) return [block, false]

  if (block.type === 'image' && isPlainObject(block.source) && typeof block.source.data === 'string') {
    return [{ ...block, source: { ...block.source, data: '' } }, true]
  }
  if (Array.isArray(block.content)) {
    const [strippedContent, contentChanged] = stripImageBlock(block.content)
    if (contentChanged) {
      return [{ ...block, content: strippedContent }, true]
    }
  }
  return [block, false]
}

/** Returns the canonicalized object or null if unchanged. */
function canonicalizeClaudeLine(o: JSONObject): JSONObject | null {
  let changed = false
  let out = o

  const message = out.message
  if (isPlainObject(message) && Array.isArray(message.content)) {
    const [strippedContent, contentChanged] = stripImageBlock(message.content)
    if (contentChanged) {
      out = { ...out, message: { ...message, content: strippedContent } }
      changed = true
    }
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
    changed = true
  }

  return changed ? out : null
}

function codexReasoningStub(o: JSONObject): JSONObject | null {
  const payload = o.payload
  if (!isPlainObject(payload)) return null
  if (payload.type !== 'reasoning' && payload.type !== 'agent_reasoning') return null

  const stub: JSONObject = { type: o.type, payload: { type: payload.type } }
  if ('timestamp' in o) stub.timestamp = o.timestamp
  return stub
}

/** Returns the canonicalized object or null if unchanged. */
function canonicalizeCodexLine(o: JSONObject): JSONObject | null {
  if (o.type === 'compacted') {
    const stub: JSONObject = { type: o.type }
    if ('timestamp' in o) stub.timestamp = o.timestamp
    return stub
  }
  const reasoningStub = codexReasoningStub(o)
  if (reasoningStub) return reasoningStub
  return null
}

/**
 * Canonicalizes a value by applying Claude Code and Codex stripping rules.
 * Returns the canonicalized object, or null if unchanged.
 * Both harnesses' irrelevant-payload shapes are structurally disjoint
 * (Claude Code lines never carry Codex's payload.type, and vice versa),
 * so applying both passes unconditionally is safe and avoids needing to
 * sniff which harness a line came from.
 */
function canonicalizeValue(value: unknown): JSONObject | null {
  if (!isPlainObject(value)) return null

  let out: JSONObject | null = null
  let changed = false

  // Apply Codex transformations first
  const codexResult = canonicalizeCodexLine(value)
  if (codexResult !== null) {
    out = codexResult
    changed = true
  } else {
    out = value
  }

  // Then apply Claude Code transformations
  const claudeResult = canonicalizeClaudeLine(out)
  if (claudeResult !== null) {
    out = claudeResult
    changed = true
  }

  return changed ? out : null
}

/**
 * Line-oriented canonicalization: non-JSON lines and lines whose parsed
 * shape doesn't match a known stripping rule pass through verbatim.
 * Lines that parse and don't require changes are returned byte-identical
 * to preserve unicode escapes, number formatting, and large integer precision.
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
    // If canonicalized is null, nothing changed; return original line byte-identical.
    // Otherwise, return the canonicalized object as JSON.
    return canonicalized === null ? line : JSON.stringify(canonicalized)
  })
  return out.join('\n')
}

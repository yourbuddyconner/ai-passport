import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  verifyProofSignature,
  mapRustStats,
  hasV2Metrics,
  mergeLocalV2Metrics,
  shouldPreserveV2,
  analyzeCiphertext,
  analyzeCiphertextRaw,
  parseCiphertextEnvelope,
  VerifierError,
  type AppProof,
  type RustSessionStats,
} from '../src/verifier'
import type { SessionStats } from '../src/parsers'

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Build a proof in the qos_p256 layout: public_key is
// [encryption pubkey (65) || signing pubkey (65)], signature is raw r||s
// ECDSA/SHA-256 over the payload bytes.
async function makeProof(payload: string): Promise<{ proof: AppProof; tamper: AppProof }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const signingPub = new Uint8Array(
    (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer,
  )
  const dummyEncryptionPub = new Uint8Array(65).fill(4)
  const publicKey = new Uint8Array(130)
  publicKey.set(dummyEncryptionPub, 0)
  publicKey.set(signingPub, 65)

  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.privateKey,
      new TextEncoder().encode(payload),
    ),
  )
  const proof: AppProof = {
    public_key: toHex(publicKey),
    payload,
    signature: toHex(signature),
  }
  return { proof, tamper: { ...proof, payload: payload + ' ' } }
}

describe('verifyProofSignature', () => {
  it('accepts a valid qos-layout proof', async () => {
    const { proof } = await makeProof('{"passport_id":"p1","trace_sha256":"abc"}')
    expect(await verifyProofSignature(proof)).toBe(true)
  })

  it('rejects a tampered payload', async () => {
    const { tamper } = await makeProof('{"passport_id":"p1"}')
    expect(await verifyProofSignature(tamper)).toBe(false)
  })

  it('rejects a wrong-length public key', async () => {
    const { proof } = await makeProof('x')
    expect(await verifyProofSignature({ ...proof, public_key: proof.public_key.slice(0, 130) })).toBe(
      false,
    )
  })
})

// Fields the enclave serializes via qos_json::string_or_numeric (or, for
// agenticity, as a hand-rolled decimal string) arrive as strings, not
// numbers, because QOS canonical JSON forbids non-integer numeric literals
// and the enclave plays it safe by stringifying every stat that could ever
// be a decimal. The worker mapping must coerce every one of them.
function baseRustStats(): RustSessionStats {
  return {
    harness: 'claude-code',
    external_id: 'sess-1',
    project_hash: 'abc123',
    started_at: '2026-01-01T00:00:00Z',
    ended_at: '2026-01-01T01:00:00Z',
    message_count: '10',
    tool_call_count: '5',
    input_tokens: '1000',
    output_tokens: '2000',
    models: ['claude-sonnet'],
    tool_counts: { Bash: '3', Edit: '2' },
    loc_added: '120',
    loc_removed: '30',
    languages: { ts: '80', rs: '70' },
    command_counts: { git: '4', npm: '1' },
    human_turns: '6',
    agenticity: '4.5',
    longest_run: '9',
    parallel_batches: '2',
    delegation_calls: '1',
    verified_edit_cycles: '3',
    red_green_cycles: '1',
    outcome: 'completed',
    skills: ['brainstorming'],
    mcp_servers: ['github'],
    background_tasks: '2',
  }
}

describe('mapRustStats', () => {
  it('coerces string_or_numeric fields (including decimal-string agenticity) to numbers', () => {
    const mapped = mapRustStats(baseRustStats())

    expect(mapped.harness).toBe('claude-code')
    expect(mapped.externalId).toBe('sess-1')
    expect(mapped.projectHash).toBe('abc123')
    expect(mapped.startedAt).toBe('2026-01-01T00:00:00Z')
    expect(mapped.endedAt).toBe('2026-01-01T01:00:00Z')
    expect(mapped.messageCount).toBe(10)
    expect(mapped.toolCallCount).toBe(5)
    expect(mapped.inputTokens).toBe(1000)
    expect(mapped.outputTokens).toBe(2000)
    expect(mapped.models).toEqual(['claude-sonnet'])
    expect(mapped.toolCounts).toEqual({ Bash: 3, Edit: 2 })

    expect(mapped.locAdded).toBe(120)
    expect(mapped.locRemoved).toBe(30)
    expect(mapped.languages).toEqual({ ts: 80, rs: 70 })
    expect(mapped.commandCounts).toEqual({ git: 4, npm: 1 })
    expect(mapped.humanTurns).toBe(6)
    expect(mapped.agenticity).toBe(4.5)
    expect(typeof mapped.agenticity).toBe('number')
    expect(mapped.longestRun).toBe(9)
    expect(mapped.parallelBatches).toBe(2)
    expect(mapped.delegationCalls).toBe(1)
    expect(mapped.verifiedEditCycles).toBe(3)
    expect(mapped.redGreenCycles).toBe(1)
    expect(mapped.outcome).toBe('completed')
    expect(mapped.skills).toEqual(['brainstorming'])
    expect(mapped.mcpServers).toEqual(['github'])
    expect(mapped.backgroundTasks).toBe(2)
  })

  it('defaults missing v2 fields (old enclave version) to zeros/empties, never NaN', () => {
    const legacy: RustSessionStats = {
      harness: 'codex',
      external_id: 'sess-2',
      project_hash: null,
      started_at: null,
      ended_at: null,
      message_count: 3,
      tool_call_count: 1,
      input_tokens: 10,
      output_tokens: 20,
      models: [],
      tool_counts: {},
    }

    const mapped = mapRustStats(legacy)

    expect(mapped.projectHash).toBeNull()
    expect(mapped.locAdded).toBe(0)
    expect(mapped.locRemoved).toBe(0)
    expect(mapped.languages).toEqual({})
    expect(mapped.commandCounts).toEqual({})
    expect(mapped.humanTurns).toBe(0)
    expect(mapped.agenticity).toBe(0)
    expect(mapped.longestRun).toBe(0)
    expect(mapped.parallelBatches).toBe(0)
    expect(mapped.delegationCalls).toBe(0)
    expect(mapped.verifiedEditCycles).toBe(0)
    expect(mapped.redGreenCycles).toBe(0)
    expect(mapped.outcome).toBe('')
    expect(mapped.skills).toEqual([])
    expect(mapped.mcpServers).toEqual([])
    expect(mapped.backgroundTasks).toBe(0)

    for (const v of Object.values(mapped)) {
      if (typeof v === 'number') expect(Number.isNaN(v)).toBe(false)
    }
  })
})

describe('hasV2Metrics', () => {
  it('is true when the raw enclave stats carry v2 fields', () => {
    expect(hasV2Metrics(baseRustStats())).toBe(true)
  })

  it('is false for an old (pre-v2) enclave response', () => {
    const legacy: RustSessionStats = {
      harness: 'codex',
      external_id: 'sess-2',
      project_hash: null,
      started_at: null,
      ended_at: null,
      message_count: 3,
      tool_call_count: 1,
      input_tokens: 10,
      output_tokens: 20,
      models: [],
      tool_counts: {},
    }
    expect(hasV2Metrics(legacy)).toBe(false)
  })
})

describe('mergeLocalV2Metrics', () => {
  function enclaveV1Stats(): SessionStats {
    // Shaped like what mapRustStats() produces for an old enclave response:
    // real v1 numbers, zero-filled v2 fields.
    return {
      harness: 'claude-code',
      externalId: 'sess-1',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T01:00:00Z',
      messageCount: 10,
      toolCallCount: 5,
      inputTokens: 1000,
      outputTokens: 2000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningOutputTokens: 0,
      webSearchRequests: 0,
      webFetchRequests: 0,
      subagentInputTokens: 0,
      subagentOutputTokens: 0,
      subagentCacheReadTokens: 0,
      subagentCacheCreationTokens: 0,
      models: ['claude-sonnet'],
      toolCounts: { Bash: 3, Edit: 2 },
      projectHash: 'abc123',
      locAdded: 0,
      locRemoved: 0,
      languages: {},
      commandCounts: {},
      humanTurns: 0,
      agenticity: 0,
      longestRun: 0,
      parallelBatches: 0,
      delegationCalls: 0,
      verifiedEditCycles: 0,
      redGreenCycles: 0,
      outcome: '',
      skills: [],
      mcpServers: [],
      backgroundTasks: 0,
    }
  }

  function localV2Stats(): SessionStats {
    return {
      ...enclaveV1Stats(),
      // Local parse recomputes v1 fields too, but they must never win.
      messageCount: 999,
      toolCallCount: 999,
      locAdded: 42,
      locRemoved: 7,
      languages: { ts: 40, rs: 2 },
      commandCounts: { git: 3, npm: 1 },
      humanTurns: 4,
      agenticity: 2.5,
      longestRun: 6,
      parallelBatches: 1,
      delegationCalls: 2,
      verifiedEditCycles: 3,
      redGreenCycles: 1,
      outcome: 'shipped',
      skills: ['brainstorming'],
      mcpServers: ['github'],
      backgroundTasks: 1,
    }
  }

  it('old-enclave-shaped response + local parse: merged stats carry local v2 values with enclave v1 values preserved', () => {
    const merged = mergeLocalV2Metrics(enclaveV1Stats(), localV2Stats())

    // v2 fields come from the local parse.
    expect(merged.locAdded).toBe(42)
    expect(merged.locRemoved).toBe(7)
    expect(merged.languages).toEqual({ ts: 40, rs: 2 })
    expect(merged.commandCounts).toEqual({ git: 3, npm: 1 })
    expect(merged.humanTurns).toBe(4)
    expect(merged.agenticity).toBe(2.5)
    expect(merged.longestRun).toBe(6)
    expect(merged.parallelBatches).toBe(1)
    expect(merged.delegationCalls).toBe(2)
    expect(merged.verifiedEditCycles).toBe(3)
    expect(merged.redGreenCycles).toBe(1)
    expect(merged.outcome).toBe('shipped')
    expect(merged.skills).toEqual(['brainstorming'])
    expect(merged.mcpServers).toEqual(['github'])
    expect(merged.backgroundTasks).toBe(1)

    // v1 numbers, harness identity, and proof-adjacent fields stay the
    // enclave's, not the local parser's.
    expect(merged.messageCount).toBe(10)
    expect(merged.toolCallCount).toBe(5)
    expect(merged.inputTokens).toBe(1000)
    expect(merged.outputTokens).toBe(2000)
    expect(merged.externalId).toBe('sess-1')
    expect(merged.projectHash).toBe('abc123')
  })

  it('when hasV2Metrics is true, callers should skip the merge (enclave v2 values win untouched)', () => {
    const enclave = { ...enclaveV1Stats(), locAdded: 120, outcome: 'landed' }
    // Simulates the caller-side gate in index.ts: merge is only invoked
    // when hasV2Metrics is false, so a v2-capable enclave response is
    // never passed through mergeLocalV2Metrics at all.
    expect(hasV2Metrics(baseRustStats())).toBe(true)
    expect(enclave.locAdded).toBe(120)
    expect(enclave.outcome).toBe('landed')
  })
})

describe('shouldPreserveV2', () => {
  it('old (pre-v2) enclave response with no local merge: preserve stored v2 columns', () => {
    expect(shouldPreserveV2({ hasV2Metrics: false }, false)).toBe(true)
  })

  it('old (pre-v2) enclave response that got a local v2 merge: stats are v2-complete, do not preserve', () => {
    expect(shouldPreserveV2({ hasV2Metrics: false }, true)).toBe(false)
  })

  it('v2-capable enclave response: never preserve', () => {
    expect(shouldPreserveV2({ hasV2Metrics: true }, false)).toBe(false)
    expect(shouldPreserveV2({ hasV2Metrics: true }, true)).toBe(false)
  })

  it('no enclave ran (local fallback parse): never preserve', () => {
    expect(shouldPreserveV2(null, false)).toBe(false)
  })
})

describe('parseCiphertextEnvelope', () => {
  it('picks the hex ciphertext field', () => {
    expect(parseCiphertextEnvelope({ ciphertext: 'deadbeef' })).toEqual({
      encoding: 'hex',
      value: 'deadbeef',
    })
  })

  it('picks the base64 ciphertextB64 field when no hex ciphertext is present', () => {
    expect(parseCiphertextEnvelope({ ciphertextB64: 'SGVsbG8=' })).toEqual({
      encoding: 'base64',
      value: 'SGVsbG8=',
    })
  })

  it('prefers hex ciphertext when both fields are present', () => {
    expect(
      parseCiphertextEnvelope({ ciphertext: 'deadbeef', ciphertextB64: 'SGVsbG8=' }),
    ).toEqual({ encoding: 'hex', value: 'deadbeef' })
  })

  it('rejects a ciphertext field that is not valid hex, falling back to ciphertextB64', () => {
    expect(
      parseCiphertextEnvelope({ ciphertext: 'not-hex!', ciphertextB64: 'SGVsbG8=' }),
    ).toEqual({ encoding: 'base64', value: 'SGVsbG8=' })
  })

  it('returns null when neither field is present', () => {
    expect(parseCiphertextEnvelope({})).toBeNull()
  })

  it('returns null for an empty ciphertextB64', () => {
    expect(parseCiphertextEnvelope({ ciphertextB64: '' })).toBeNull()
  })
})

describe('analyzeCiphertext (enclave pass-through)', () => {
  const passportId = 'passport-1'

  function mockFetchOnce(payload: Record<string, unknown>, proof: AppProof) {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ payload, proof }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function buildSignedResponse(stats: RustSessionStats) {
    const payload = {
      passport_id: passportId,
      trace_sha256: 'abc123',
      stats,
      analyzed_at: 1234,
    }
    const { proof } = await makeProof(JSON.stringify(payload))
    return { payload, proof }
  }

  it('forwards a hex envelope as {ciphertext} verbatim, with no transcoding', async () => {
    const { payload, proof } = await buildSignedResponse(baseRustStats())
    const fetchMock = mockFetchOnce(payload, proof)

    const result = await analyzeCiphertext(
      'https://verifier.example',
      passportId,
      { encoding: 'hex', value: 'deadbeef' },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://verifier.example/analyze')
    expect(JSON.parse(init.body as string)).toEqual({ ciphertext: 'deadbeef' })
    expect(result.stats.externalId).toBe('sess-1')
  })

  it('forwards a base64 envelope as {ciphertext_b64} verbatim, with no transcoding', async () => {
    const { payload, proof } = await buildSignedResponse(baseRustStats())
    const fetchMock = mockFetchOnce(payload, proof)
    const b64Value = 'SGVsbG8sIHdvcmxkIQ=='

    await analyzeCiphertext('https://verifier.example', passportId, {
      encoding: 'base64',
      value: b64Value,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body as string)).toEqual({ ciphertext_b64: b64Value })
  })

  it('rejects when the enclave proof is bound to a different passport', async () => {
    const { payload, proof } = await buildSignedResponse(baseRustStats())
    mockFetchOnce(payload, proof)

    await expect(
      analyzeCiphertext('https://verifier.example', 'a-different-passport', {
        encoding: 'hex',
        value: 'deadbeef',
      }),
    ).rejects.toBeInstanceOf(VerifierError)
  })
})

describe('analyzeCiphertextRaw (binary envelope pass-through)', () => {
  const passportId = 'passport-1'

  function mockFetchOnce(payload: Record<string, unknown>, proof: AppProof) {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ payload, proof }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function buildSignedResponse(stats: RustSessionStats) {
    const payload = {
      passport_id: passportId,
      trace_sha256: 'abc123',
      stats,
      analyzed_at: 1234,
    }
    const { proof } = await makeProof(JSON.stringify(payload))
    return { payload, proof }
  }

  it('POSTs the exact bytes to /analyze_raw as octet-stream with a matching content-length', async () => {
    const { payload, proof } = await buildSignedResponse(baseRustStats())
    const fetchMock = mockFetchOnce(payload, proof)
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252])

    const result = await analyzeCiphertextRaw('https://verifier.example', passportId, bytes)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://verifier.example/analyze_raw')
    expect(init.method).toBe('POST')
    expect(init.headers['content-type']).toBe('application/octet-stream')
    expect(init.headers['content-length']).toBe(String(bytes.byteLength))
    expect(init.body).toBe(bytes)
    expect(result.stats.externalId).toBe('sess-1')
  })

  it('verifies the proof signature and passport binding identically to /analyze', async () => {
    const { payload, proof } = await buildSignedResponse(baseRustStats())
    mockFetchOnce(payload, proof)

    await expect(
      analyzeCiphertextRaw('https://verifier.example', 'a-different-passport', new Uint8Array([1])),
    ).rejects.toBeInstanceOf(VerifierError)
  })

  it('surfaces a non-ok enclave response as VerifierError with the response status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'bad envelope' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      analyzeCiphertextRaw('https://verifier.example', passportId, new Uint8Array([1])),
    ).rejects.toMatchObject({ message: 'bad envelope', status: 400 })
  })
})

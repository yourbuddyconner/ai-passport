import { describe, it, expect } from 'vitest'
import { verifyProofSignature, mapRustStats, type AppProof, type RustSessionStats } from '../src/verifier'

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

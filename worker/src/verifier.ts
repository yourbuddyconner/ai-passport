// Client for the passport-verifier TVC enclave app (see ../../verifier/).
//
// The enclave is a stateless coprocessor: we send it a quorum-key-encrypted
// envelope {passport_id, trace} and get back parsed session stats signed by
// the enclave's ephemeral key. Locally and in prod the app is identical; prod
// adds an attestation document binding the keys to the enclave image, which
// verifyAttestation() will check once TVC prod is wired up.

import type { SessionStats } from './parsers'
import { encryptToQuorumKey } from './qosCrypto'

export interface AppProof {
  public_key: string
  payload: string
  signature: string
}

export interface EnclaveAnalysis {
  stats: SessionStats
  traceSha256: string
  analyzedAt: number
  proof: AppProof
  /**
   * Whether the raw enclave response actually contained the v2 metrics
   * fields (loc/language/agenticity/outcome/etc). Old (pre-v2) enclave
   * builds omit them entirely, and mapRustStats() zero-fills them — callers
   * that need real numbers should fall back to local parsing when this is
   * false rather than trust the zeros.
   */
  hasV2Metrics: boolean
}

export class VerifierError extends Error {
  constructor(
    message: string,
    public status = 502,
  ) {
    super(message)
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

// qos_p256 public keys are 130 bytes: [encryption pubkey (65) || signing pubkey (65)],
// each an uncompressed SEC1 P-256 point. Signatures are ECDSA/SHA-256, raw r||s.
export async function verifyProofSignature(proof: AppProof): Promise<boolean> {
  const pub = hexToBytes(proof.public_key)
  if (pub.length !== 130) return false
  const signingKey = pub.slice(65)
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      signingKey.buffer as ArrayBuffer,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      hexToBytes(proof.signature).buffer as ArrayBuffer,
      new TextEncoder().encode(proof.payload),
    )
  } catch {
    return false
  }
}

// Attestation verification hook. In local dev the enclave runs with static
// dev keys and there is nothing to attest. In prod, this must fetch the
// enclave's Nitro attestation document, verify the certificate chain to the
// AWS Nitro root, check the PCRs against the reproducible StageX build, and
// confirm the quorum/ephemeral public keys are bound in the document's
// user data. Until then we record the mode so cards can be honest about it.
export function attestationMode(env: { VERIFIER_ATTESTED?: string }): 'attested' | 'dev' {
  return env.VERIFIER_ATTESTED === 'true' ? 'attested' : 'dev'
}

// The enclave serializes most numeric stats via qos_json::string_or_numeric
// (and `agenticity`, which can't round-trip through QOS's integer-only
// canonical JSON, as a hand-rolled decimal string) so any of these may
// arrive as a string. The v2 fields are optional here so older enclave
// builds that predate them still decode.
export interface RustSessionStats {
  harness: string
  external_id: string
  project_hash?: string | null
  started_at: string | null
  ended_at: string | null
  message_count: number | string
  tool_call_count: number | string
  input_tokens: number | string
  output_tokens: number | string
  models: string[]
  tool_counts: Record<string, number | string>
  loc_added?: number | string
  loc_removed?: number | string
  languages?: Record<string, number | string>
  command_counts?: Record<string, number | string>
  human_turns?: number | string
  agenticity?: number | string
  longest_run?: number | string
  parallel_batches?: number | string
  delegation_calls?: number | string
  verified_edit_cycles?: number | string
  red_green_cycles?: number | string
  outcome?: string
  skills?: string[]
  mcp_servers?: string[]
  background_tasks?: number | string
}

function numberRecord(rec: Record<string, number | string> | undefined): Record<string, number> {
  return Object.fromEntries(Object.entries(rec ?? {}).map(([k, v]) => [k, Number(v)]))
}

/**
 * True when the raw enclave stats actually carried v2 fields. Any v2 field
 * is sufficient to detect this (the enclave always emits all of them or
 * none), so we check one that is unambiguous even for a legitimately empty
 * trace: `loc_added` is always present (possibly `0`) on v2 builds and
 * always absent on pre-v2 builds.
 */
export function hasV2Metrics(s: RustSessionStats): boolean {
  return s.loc_added !== undefined
}

/**
 * Copy only the v2 metric fields from a locally-parsed trace onto
 * enclave-derived stats, leaving the enclave's v1 numbers, verification
 * level, and proof untouched.
 */
export function mergeLocalV2Metrics(
  enclaveStats: SessionStats,
  localStats: SessionStats,
): SessionStats {
  return {
    ...enclaveStats,
    locAdded: localStats.locAdded,
    locRemoved: localStats.locRemoved,
    languages: localStats.languages,
    commandCounts: localStats.commandCounts,
    humanTurns: localStats.humanTurns,
    agenticity: localStats.agenticity,
    longestRun: localStats.longestRun,
    parallelBatches: localStats.parallelBatches,
    delegationCalls: localStats.delegationCalls,
    verifiedEditCycles: localStats.verifiedEditCycles,
    redGreenCycles: localStats.redGreenCycles,
    outcome: localStats.outcome,
    skills: localStats.skills,
    mcpServers: localStats.mcpServers,
    backgroundTasks: localStats.backgroundTasks,
  }
}

/**
 * Whether the stats about to be persisted for a re-upload lack real v2
 * metrics, so the caller must avoid overwriting a previously-stored v2
 * row with zeros. True only for an old (pre-v2) enclave response that was
 * never merged with a local v2 parse — once merged (or if the enclave
 * response was already v2-capable, or no enclave ran at all and stats came
 * from the local parser directly), the stats carry real v2 data and must
 * never be preserved-around.
 */
export function shouldPreserveV2(
  analysis: { hasV2Metrics: boolean } | null,
  merged: boolean,
): boolean {
  if (!analysis) return false
  return !analysis.hasV2Metrics && !merged
}

/** Map the enclave's snake_case wire format to the worker's SessionStats shape. */
export function mapRustStats(s: RustSessionStats): SessionStats {
  return {
    harness: s.harness as SessionStats['harness'],
    externalId: s.external_id,
    startedAt: s.started_at,
    endedAt: s.ended_at,
    messageCount: Number(s.message_count),
    toolCallCount: Number(s.tool_call_count),
    inputTokens: Number(s.input_tokens),
    outputTokens: Number(s.output_tokens),
    models: s.models,
    toolCounts: numberRecord(s.tool_counts),
    projectHash: s.project_hash ?? null,
    locAdded: Number(s.loc_added ?? 0),
    locRemoved: Number(s.loc_removed ?? 0),
    languages: numberRecord(s.languages),
    commandCounts: numberRecord(s.command_counts),
    humanTurns: Number(s.human_turns ?? 0),
    agenticity: Number(s.agenticity ?? 0),
    longestRun: Number(s.longest_run ?? 0),
    parallelBatches: Number(s.parallel_batches ?? 0),
    delegationCalls: Number(s.delegation_calls ?? 0),
    verifiedEditCycles: Number(s.verified_edit_cycles ?? 0),
    redGreenCycles: Number(s.red_green_cycles ?? 0),
    outcome: s.outcome ?? '',
    skills: s.skills ?? [],
    mcpServers: s.mcp_servers ?? [],
    backgroundTasks: Number(s.background_tasks ?? 0),
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Fetch the enclave's quorum public key (130-byte dual key, hex). */
export async function fetchQuorumPublicKey(verifierUrl: string): Promise<string> {
  const keyRes = await fetch(`${verifierUrl}/quorum_public_key`)
  if (!keyRes.ok) throw new VerifierError(`enclave key fetch failed: HTTP ${keyRes.status}`)
  const { public_key } = (await keyRes.json()) as { public_key: string }
  return public_key
}

/**
 * Send an already-encrypted envelope to the enclave and verify the returned
 * proof: signature over the exact payload bytes and the passport binding.
 * (When the caller encrypted client-side we never see the plaintext, so the
 * trace hash in the signed payload is recorded, not re-derived.)
 */
export async function analyzeCiphertext(
  verifierUrl: string,
  passportId: string,
  ciphertext: string,
): Promise<EnclaveAnalysis> {
  const analyzeRes = await fetch(`${verifierUrl}/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ciphertext }),
  })
  if (!analyzeRes.ok) {
    const body = (await analyzeRes.json().catch(() => null)) as { error?: string } | null
    // 400 = bad envelope/decrypt, 422 = the enclave parsed and rejected the trace.
    throw new VerifierError(body?.error ?? `enclave analyze failed`, analyzeRes.status)
  }
  const result = (await analyzeRes.json()) as {
    payload: {
      passport_id: string
      trace_sha256: string
      stats: RustSessionStats
      analyzed_at: number
    }
    proof: AppProof
  }

  if (!(await verifyProofSignature(result.proof)))
    throw new VerifierError('enclave proof signature did not verify')
  const signed = JSON.parse(result.proof.payload) as typeof result.payload
  if (signed.passport_id !== passportId)
    throw new VerifierError('enclave proof is bound to a different passport', 422)

  return {
    stats: mapRustStats(signed.stats),
    traceSha256: signed.trace_sha256,
    analyzedAt: Number(signed.analyzed_at),
    proof: result.proof,
    hasV2Metrics: hasV2Metrics(signed.stats),
  }
}

/**
 * Analyze a plaintext trace via the enclave (Worker-side encryption path,
 * used when the client didn't encrypt). Additionally re-derives and checks
 * the trace hash against the signed payload.
 */
export async function analyzeViaEnclave(
  verifierUrl: string,
  passportId: string,
  trace: string,
): Promise<{ ciphertext: string; analysis: EnclaveAnalysis }> {
  const envelope = JSON.stringify({ passport_id: passportId, trace })
  const publicKey = await fetchQuorumPublicKey(verifierUrl)
  const ciphertext = await encryptToQuorumKey(publicKey, new TextEncoder().encode(envelope))

  const analysis = await analyzeCiphertext(verifierUrl, passportId, ciphertext)
  if (analysis.traceSha256 !== (await sha256Hex(trace)))
    throw new VerifierError('enclave proof trace hash mismatch')
  return { ciphertext, analysis }
}

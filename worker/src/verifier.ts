// Client for the passport-verifier TVC enclave app (see ../../verifier/).
//
// The enclave is a stateless coprocessor: we send it a quorum-key-encrypted
// envelope {passport_id, trace} and get back parsed session stats signed by
// the enclave's ephemeral key. Locally and in prod the app is identical; prod
// adds an attestation document binding the keys to the enclave image, which
// verifyAttestation() will check once TVC prod is wired up.

import type { SessionStats } from './parsers'

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

interface RustSessionStats {
  harness: string
  external_id: string
  started_at: string | null
  ended_at: string | null
  message_count: number
  tool_call_count: number
  input_tokens: number
  output_tokens: number
  models: string[]
  tool_counts: Record<string, number>
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Analyze a trace via the enclave. Encrypts the envelope to the quorum key,
 * calls /analyze, then verifies the returned proof: signature over the exact
 * payload bytes, passport binding, and trace hash.
 *
 * NOTE: envelope encryption currently round-trips through the verifier's
 * /quorum_key/encrypt convenience endpoint. In the target design the browser
 * encrypts before upload so this Worker never sees plaintext; that swap only
 * changes where encrypt() runs, nothing else in this flow.
 */
export async function analyzeViaEnclave(
  verifierUrl: string,
  passportId: string,
  trace: string,
): Promise<{ ciphertext: string; analysis: EnclaveAnalysis }> {
  const envelope = JSON.stringify({ passport_id: passportId, trace })

  const encryptRes = await fetch(`${verifierUrl}/quorum_key/encrypt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ plaintext: envelope }),
  })
  if (!encryptRes.ok) throw new VerifierError(`enclave encrypt failed: HTTP ${encryptRes.status}`)
  const { ciphertext } = (await encryptRes.json()) as { ciphertext: string }

  const analyzeRes = await fetch(`${verifierUrl}/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ciphertext }),
  })
  if (!analyzeRes.ok) {
    const body = (await analyzeRes.json().catch(() => null)) as { error?: string } | null
    // 422 = the enclave parsed and rejected the trace; surface as a user error.
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
    throw new VerifierError('enclave proof is bound to a different passport')
  if (signed.trace_sha256 !== (await sha256Hex(trace)))
    throw new VerifierError('enclave proof trace hash mismatch')

  const s = signed.stats
  return {
    ciphertext,
    analysis: {
      stats: {
        harness: s.harness as SessionStats['harness'],
        externalId: s.external_id,
        startedAt: s.started_at,
        endedAt: s.ended_at,
        messageCount: Number(s.message_count),
        toolCallCount: Number(s.tool_call_count),
        inputTokens: Number(s.input_tokens),
        outputTokens: Number(s.output_tokens),
        models: s.models,
        toolCounts: Object.fromEntries(
          Object.entries(s.tool_counts).map(([k, v]) => [k, Number(v)]),
        ),
      },
      traceSha256: signed.trace_sha256,
      analyzedAt: Number(signed.analyzed_at),
      proof: result.proof,
    },
  }
}

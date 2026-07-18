import { describe, it, expect } from 'vitest'
import { verifyProofSignature, type AppProof } from '../src/verifier'

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Build a proof in the qos_p256 layout: public_key is
// [encryption pubkey (65) || signing pubkey (65)], signature is raw r||s
// ECDSA/SHA-256 over the payload bytes.
async function makeProof(payload: string): Promise<{ proof: AppProof; tamper: AppProof }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const signingPub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
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

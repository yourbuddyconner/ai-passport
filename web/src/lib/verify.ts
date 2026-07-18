// Client-side verification of enclave app proofs — the same check anyone can
// run independently: no server trust required beyond fetching the card JSON.
//
// qos_p256 public keys are 130 bytes hex: [encryption pubkey (65) || signing
// pubkey (65)], each an uncompressed SEC1 P-256 point. Signatures are
// ECDSA/SHA-256 over the exact payload string, raw r||s encoding.

export interface AppProof {
  public_key: string
  payload: string
  signature: string
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export async function verifyProofSignature(proof: AppProof): Promise<boolean> {
  const pub = hexToBytes(proof.public_key)
  if (pub.length !== 130) return false
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      pub.slice(65).buffer as ArrayBuffer,
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

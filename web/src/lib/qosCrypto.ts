// WebCrypto port of qos_p256's ECIES encryption (qos_p256/src/encrypt.rs).
//
// Encrypting to the enclave's quorum key locally means only hex ciphertext
// ever crosses the wire to the enclave — no plaintext through any ingress or
// WAF, and no dependence on the enclave's /quorum_key/encrypt endpoint.
//
// Scheme (must match qos_p256 exactly):
//   1. ephemeral P-256 keypair
//   2. shared_secret = ECDH(ephemeral_priv, receiver_pub)  (32-byte x-coord)
//   3. pre_image = ephemeral_pub(65) || receiver_pub(65) || shared_secret
//   4. key = HMAC-SHA512(key=pre_image, msg="qos_encryption_hmac_message")[0..32]
//   5. AES-256-GCM with random 12-byte nonce and
//      AAD = ephemeral_pub || [65] || receiver_pub || [65]
//   6. envelope (borsh) = nonce(12) || ephemeral_pub(65) || ct_len_u32_le || ct
//
// The receiver key is the FIRST 65 bytes of a qos dual public key
// (`encrypt_public || sign_public`).

const HMAC_MESSAGE = new TextEncoder().encode('qos_encryption_hmac_message')

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/** Chunked base64 — String.fromCharCode has an argument-count limit. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export async function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Encrypt `message` to a qos_p256 dual public key (130 bytes hex).
 * Returns the raw borsh envelope bytes that `P256Pair::decrypt` accepts.
 */
export async function encryptToQuorumKeyRaw(
  dualPublicKeyHex: string,
  message: Uint8Array,
): Promise<Uint8Array> {
  const dual = hexToBytes(dualPublicKeyHex)
  if (dual.length !== 130) throw new Error(`expected 130-byte dual public key, got ${dual.length}`)
  const receiverPub = dual.slice(0, 65)

  const receiverKey = await crypto.subtle.importKey(
    'raw',
    receiverPub.buffer as ArrayBuffer,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const ephemeral = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair
  const ephemeralPub = new Uint8Array(
    (await crypto.subtle.exportKey('raw', ephemeral.publicKey)) as ArrayBuffer,
  )
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      // workers-types names this field `$public`; runtime uses `public`.
      { name: 'ECDH', public: receiverKey } as unknown as Parameters<
        typeof crypto.subtle.deriveBits
      >[0],
      ephemeral.privateKey,
      256,
    ),
  )

  const preImage = concat(ephemeralPub, receiverPub, sharedSecret)
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    preImage.buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  )
  const sharedKey = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, HMAC_MESSAGE)).slice(
    0,
    32,
  )

  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const aad = concat(ephemeralPub, new Uint8Array([65]), receiverPub, new Uint8Array([65]))
  const aesKey = await crypto.subtle.importKey(
    'raw',
    sharedKey.buffer as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  )
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce.buffer as ArrayBuffer,
        additionalData: aad.buffer as ArrayBuffer,
        tagLength: 128,
      },
      aesKey,
      message.buffer as ArrayBuffer,
    ),
  )

  // borsh: fixed-size arrays are raw bytes; Vec<u8> is u32 LE length prefix.
  const lenLe = new Uint8Array(4)
  new DataView(lenLe.buffer).setUint32(0, ciphertext.length, true)
  return concat(nonce, ephemeralPub, lenLe, ciphertext)
}

/**
 * Encrypt `message` to a qos_p256 dual public key (130 bytes hex).
 * Returns the hex-encoded borsh envelope that `P256Pair::decrypt` accepts.
 */
export async function encryptToQuorumKey(
  dualPublicKeyHex: string,
  message: Uint8Array,
): Promise<string> {
  return bytesToHex(await encryptToQuorumKeyRaw(dualPublicKeyHex, message))
}

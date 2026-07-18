import { encryptToQuorumKey } from './qosCrypto'

export interface PassportCredentials {
  id: string
  slug: string
  editToken: string
  name: string
}

export interface CardData {
  totalSessions: number
  totalMessages: number
  totalToolCalls: number
  totalInputTokens: number
  totalOutputTokens: number
  activeHours: number
  activeDays: number
  firstActivity: string | null
  lastActivity: string | null
  harnesses: string[]
  models: string[]
  topTools: Array<{ name: string; count: number }>
  score: number
  grade: string
  scoreBreakdown: Record<string, number>
}

export interface SessionProofView {
  externalId: string
  harness: string
  verification: 'enclave' | 'format'
  proof: { public_key: string; payload: string; signature: string } | null
}

export interface PassportView {
  passport: { slug: string; name: string; createdAt: string }
  card: CardData
  verification: {
    attestation: 'attested' | 'dev'
    enclaveSessions: number
    totalSessions: number
  }
  sessions: SessionProofView[]
}

const STORAGE_KEY = 'ai-passport'

export function loadCredentials(): PassportCredentials | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as PassportCredentials) : null
  } catch {
    return null
  }
}

export function saveCredentials(creds: PassportCredentials) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(creds))
}

export function clearCredentials() {
  localStorage.removeItem(STORAGE_KEY)
}

export async function createPassport(name: string): Promise<PassportCredentials> {
  const res = await fetch('/api/passports', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Failed to create passport')
  const data = await res.json()
  return { ...data, name }
}

export interface UploadResult {
  fileName: string
  ok: boolean
  duplicate?: boolean
  error?: string
  harness?: string
  toolCallCount?: number
  messageCount?: number
  verification?: 'enclave' | 'format'
  encryptedInBrowser?: boolean
}

/** Check that saved credentials still point at a real passport. */
export async function validateCredentials(creds: PassportCredentials): Promise<boolean> {
  const res = await fetch(`/api/passports/${creds.id}`)
  if (res.status === 404) return false
  return true // network errors etc. shouldn't nuke credentials
}

let quorumKeyPromise: Promise<string | null> | null = null
function getQuorumKey(): Promise<string | null> {
  quorumKeyPromise ??= fetch('/api/verifier/public-key')
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => data?.publicKey ?? null)
    .catch(() => null)
  return quorumKeyPromise
}

export async function uploadTrace(
  creds: PassportCredentials,
  file: File,
): Promise<UploadResult> {
  const text = await file.text()

  // End-to-end encryption: seal {passport_id, trace} to the enclave's quorum
  // key right here in the browser. The server only ever sees ciphertext.
  // Falls back to plaintext upload when no verifier is configured.
  const quorumKey = await getQuorumKey()
  let res: Response
  if (quorumKey) {
    const envelope = JSON.stringify({ passport_id: creds.id, trace: text })
    const ciphertext = await encryptToQuorumKey(quorumKey, new TextEncoder().encode(envelope))
    res = await fetch(`/api/passports/${creds.id}/sessions`, {
      method: 'POST',
      headers: { 'x-edit-token': creds.editToken, 'content-type': 'application/json' },
      body: JSON.stringify({ ciphertext }),
    })
  } else {
    res = await fetch(`/api/passports/${creds.id}/sessions`, {
      method: 'POST',
      headers: { 'x-edit-token': creds.editToken, 'content-type': 'text/plain' },
      body: text,
    })
  }

  const data = await res.json().catch(() => null)
  if (!res.ok) return { fileName: file.name, ok: false, error: data?.error ?? `HTTP ${res.status}` }
  return {
    fileName: file.name,
    ok: true,
    duplicate: data.duplicate,
    harness: data.session?.harness,
    toolCallCount: data.session?.toolCallCount,
    messageCount: data.session?.messageCount,
    verification: data.verification,
    encryptedInBrowser: !!quorumKey,
  }
}

export async function fetchPassport(slug: string): Promise<PassportView> {
  const res = await fetch(`/api/passports/slug/${slug}`)
  if (!res.ok) throw new Error('Passport not found')
  return res.json()
}

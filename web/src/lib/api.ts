import { bytesToBase64, encryptToQuorumKeyRaw, gzipBytes } from './qosCrypto'

const MAX_UPLOAD_BYTES = 256 * 1024 * 1024
const MAX_CIPHERTEXT_B64_LENGTH = 90 * 1024 * 1024

export interface PassportCredentials {
  id: string
  slug: string
  editToken: string
  name: string
}

export interface Achievement {
  id: string
  name: string
  description: string
  earned: boolean
  progress: { current: number; target: number } | null
}

export interface CardData {
  totalSessions: number
  repositories: number
  achievements: Achievement[]
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
  locAdded: number
  locRemoved: number
  languages: Record<string, number>
  commandMix: Array<{ category: string; count: number; share: number }>
  testShare: number
  outcomes: Record<string, number>
  concludedSessions: number
  agenticity: number
  longestRun: number
  delegationCalls: number
  redGreenCycles: number
  verifiedEditCycles: number
  skills: string[]
  mcpServers: string[]
  backgroundTasks: number
  maxConcurrentSessions: number
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
  reprocessed?: boolean
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
  if (file.size > MAX_UPLOAD_BYTES) {
    return { fileName: file.name, ok: false, error: 'trace exceeds the 256 MB limit' }
  }
  const text = await file.text()

  // End-to-end encryption: seal {passport_id, trace} to the enclave's quorum
  // key right here in the browser. The server only ever sees ciphertext.
  // Falls back to plaintext upload when no verifier is configured.
  const quorumKey = await getQuorumKey()
  let res: Response
  if (quorumKey) {
    const envelope = JSON.stringify({ passport_id: creds.id, trace: text })
    const compressed = await gzipBytes(new TextEncoder().encode(envelope))
    const ciphertext = await encryptToQuorumKeyRaw(quorumKey, compressed)
    const ciphertextB64 = bytesToBase64(ciphertext)
    if (ciphertextB64.length > MAX_CIPHERTEXT_B64_LENGTH) {
      return {
        fileName: file.name,
        ok: false,
        error: 'trace too large even after compression — split the session',
      }
    }
    res = await fetch(`/api/passports/${creds.id}/sessions`, {
      method: 'POST',
      headers: { 'x-edit-token': creds.editToken, 'content-type': 'application/json' },
      body: JSON.stringify({ ciphertextB64 }),
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
    reprocessed: data.reprocessed,
    harness: data.session?.harness,
    toolCallCount: data.session?.toolCallCount,
    messageCount: data.session?.messageCount,
    verification: data.verification,
    encryptedInBrowser: !!quorumKey,
  }
}

export async function deleteSession(passportId: string, externalId: string): Promise<boolean> {
  const res = await fetch(`/api/passports/${passportId}/sessions/${externalId}`, {
    method: 'DELETE',
  })
  return res.ok
}

export async function fetchPassport(slug: string): Promise<PassportView> {
  const res = await fetch(`/api/passports/slug/${slug}`)
  if (!res.ok) throw new Error('Passport not found')
  return res.json()
}

// ---------- Passkey accounts ----------

export interface SessionSummary {
  externalId: string
  harness: string
  startedAt: string | null
  endedAt: string | null
  messageCount: number
  toolCallCount: number
  verification: 'enclave' | 'format'
  models: string[]
}

export interface Me {
  user: { displayName: string; title: string | null; onboarded: boolean }
  passport: { id: string; slug: string; name: string }
  card: CardData
  sessions: SessionSummary[]
}

export async function fetchMe(): Promise<Me | null> {
  const res = await fetch('/api/me')
  if (res.status === 401) return null
  if (!res.ok) throw new Error('failed to load your passport')
  return res.json()
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' })
}

export async function submitOnboarding(displayName: string, title: string): Promise<void> {
  const res = await fetch('/api/me/onboarding', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName, title }),
  })
  if (!res.ok) throw new Error('failed to save profile')
}

/** Upload for a passkey-authenticated owner (session cookie, no edit token). */
export async function uploadTraceAsOwner(passportId: string, file: File): Promise<UploadResult> {
  if (file.size > MAX_UPLOAD_BYTES) {
    return { fileName: file.name, ok: false, error: 'trace exceeds the 256 MB limit' }
  }
  const text = await file.text()
  const quorumKey = await getQuorumKey()
  let res: Response
  if (quorumKey) {
    const envelope = JSON.stringify({ passport_id: passportId, trace: text })
    const compressed = await gzipBytes(new TextEncoder().encode(envelope))
    const ciphertext = await encryptToQuorumKeyRaw(quorumKey, compressed)
    const ciphertextB64 = bytesToBase64(ciphertext)
    if (ciphertextB64.length > MAX_CIPHERTEXT_B64_LENGTH) {
      return {
        fileName: file.name,
        ok: false,
        error: 'trace too large even after compression — split the session',
      }
    }
    res = await fetch(`/api/passports/${passportId}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ciphertextB64 }),
    })
  } else {
    res = await fetch(`/api/passports/${passportId}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
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

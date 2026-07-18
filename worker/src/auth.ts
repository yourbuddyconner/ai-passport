// Passkey (WebAuthn) auth: registration, login, and cookie sessions.
//
// Passkeys authenticate the person; they are unrelated to trace encryption
// (traces are sealed to the enclave's public key, which needs no user
// secret). One user owns one passport, created at registration.

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
} from '@simplewebauthn/server'

export interface AuthEnv {
  DB: D1Database
}

const RP_NAME = 'AI Passport'
const CHALLENGE_TTL_MS = 5 * 60 * 1000
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const SESSION_COOKIE = 'ai_passport_session'

export function rpFrom(requestUrl: string): { rpID: string; origin: string } {
  const url = new URL(requestUrl)
  return { rpID: url.hostname, origin: url.origin }
}

async function saveChallenge(env: AuthEnv, kind: 'register' | 'login', challenge: string) {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    'INSERT INTO auth_challenges (id, challenge, kind, created_at) VALUES (?, ?, ?, ?)',
  )
    .bind(id, challenge, kind, new Date().toISOString())
    .run()
  return id
}

/** Consume a stored challenge (one-shot, TTL-checked). */
async function takeChallenge(
  env: AuthEnv,
  id: string,
  kind: 'register' | 'login',
): Promise<string | null> {
  const row = await env.DB.prepare(
    'SELECT challenge, created_at FROM auth_challenges WHERE id = ? AND kind = ?',
  )
    .bind(id, kind)
    .first<{ challenge: string; created_at: string }>()
  if (!row) return null
  await env.DB.prepare('DELETE FROM auth_challenges WHERE id = ?').bind(id).run()
  if (Date.now() - Date.parse(row.created_at) > CHALLENGE_TTL_MS) return null
  return row.challenge
}

export async function registrationOptions(env: AuthEnv, requestUrl: string, name: string) {
  const { rpID } = rpFrom(requestUrl)
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: name,
    userDisplayName: name,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  })
  const challengeId = await saveChallenge(env, 'register', options.challenge)
  return { options, challengeId }
}

export async function verifyRegistration(
  env: AuthEnv,
  requestUrl: string,
  challengeId: string,
  name: string,
  response: RegistrationResponseJSON,
) {
  const { rpID, origin } = rpFrom(requestUrl)
  const expectedChallenge = await takeChallenge(env, challengeId, 'register')
  if (!expectedChallenge) throw new Error('challenge expired — try again')

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: false,
  })
  if (!verification.verified || !verification.registrationInfo)
    throw new Error('passkey registration could not be verified')

  const { credential } = verification.registrationInfo
  const userId = crypto.randomUUID()
  const now = new Date().toISOString()
  await env.DB.prepare(
    'INSERT INTO users (id, display_name, onboarded, created_at) VALUES (?, ?, 0, ?)',
  )
    .bind(userId, name.trim().slice(0, 80), now)
    .run()
  await env.DB.prepare(
    'INSERT INTO credentials (id, user_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(
      credential.id,
      userId,
      btoa(String.fromCharCode(...credential.publicKey))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, ''),
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      now,
    )
    .run()
  return userId
}

export async function authenticationOptions(env: AuthEnv, requestUrl: string) {
  const { rpID } = rpFrom(requestUrl)
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
  })
  const challengeId = await saveChallenge(env, 'login', options.challenge)
  return { options, challengeId }
}

export async function verifyAuthentication(
  env: AuthEnv,
  requestUrl: string,
  challengeId: string,
  response: AuthenticationResponseJSON,
): Promise<string> {
  const { rpID, origin } = rpFrom(requestUrl)
  const expectedChallenge = await takeChallenge(env, challengeId, 'login')
  if (!expectedChallenge) throw new Error('challenge expired — try again')

  const cred = await env.DB.prepare(
    'SELECT id, user_id, public_key, counter, transports FROM credentials WHERE id = ?',
  )
    .bind(response.id)
    .first<{
      id: string
      user_id: string
      public_key: string
      counter: number
      transports: string
    }>()
  if (!cred) throw new Error('unknown passkey — register first')

  const publicKey = Uint8Array.from(
    atob(cred.public_key.replace(/-/g, '+').replace(/_/g, '/')),
    (ch) => ch.charCodeAt(0),
  )
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: false,
    credential: {
      id: cred.id,
      publicKey,
      counter: cred.counter,
      transports: JSON.parse(cred.transports || '[]') as AuthenticatorTransportFuture[],
    },
  })
  if (!verification.verified) throw new Error('passkey could not be verified')

  await env.DB.prepare('UPDATE credentials SET counter = ? WHERE id = ?')
    .bind(verification.authenticationInfo.newCounter, cred.id)
    .run()
  return cred.user_id
}

export async function createLoginSession(env: AuthEnv, userId: string): Promise<string> {
  const id = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '')
  const now = Date.now()
  await env.DB.prepare(
    'INSERT INTO login_sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  )
    .bind(id, userId, new Date(now).toISOString(), new Date(now + SESSION_TTL_MS).toISOString())
    .run()
  return id
}

export function sessionCookie(sessionId: string): string {
  return `${SESSION_COOKIE}=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`
}

export interface AuthedUser {
  id: string
  displayName: string
  title: string | null
  onboarded: boolean
}

export async function userFromCookie(
  env: AuthEnv,
  cookieHeader: string | undefined,
): Promise<AuthedUser | null> {
  const match = cookieHeader?.match(new RegExp(`${SESSION_COOKIE}=([\\w-]+)`))
  if (!match) return null
  const session = await env.DB.prepare(
    `SELECT u.id, u.display_name, u.title, u.onboarded
     FROM login_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ?`,
  )
    .bind(match[1], new Date().toISOString())
    .first<{ id: string; display_name: string; title: string | null; onboarded: number }>()
  if (!session) return null
  return {
    id: session.id,
    displayName: session.display_name,
    title: session.title,
    onboarded: !!session.onboarded,
  }
}

export async function deleteSession(env: AuthEnv, cookieHeader: string | undefined) {
  const match = cookieHeader?.match(new RegExp(`${SESSION_COOKIE}=([\\w-]+)`))
  if (match) await env.DB.prepare('DELETE FROM login_sessions WHERE id = ?').bind(match[1]).run()
}

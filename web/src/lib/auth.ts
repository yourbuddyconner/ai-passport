import { startRegistration, startAuthentication } from '@simplewebauthn/browser'

// Passkey ceremonies. The passkey authenticates the person; trace encryption
// is separate (sealed to the enclave's public key — see lib/qosCrypto.ts).

export async function registerWithPasskey(name: string): Promise<void> {
  const optRes = await fetch('/api/auth/register/options', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!optRes.ok) throw new Error((await optRes.json().catch(() => null))?.error ?? 'could not start registration')
  const { options, challengeId } = await optRes.json()
  const response = await startRegistration({ optionsJSON: options })
  const verifyRes = await fetch('/api/auth/register/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId, name, response }),
  })
  if (!verifyRes.ok)
    throw new Error((await verifyRes.json().catch(() => null))?.error ?? 'registration failed')
}

export async function loginWithPasskey(): Promise<void> {
  const optRes = await fetch('/api/auth/login/options', { method: 'POST' })
  if (!optRes.ok) throw new Error('could not start sign-in')
  const { options, challengeId } = await optRes.json()
  const response = await startAuthentication({ optionsJSON: options })
  const verifyRes = await fetch('/api/auth/login/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId, response }),
  })
  if (!verifyRes.ok)
    throw new Error((await verifyRes.json().catch(() => null))?.error ?? 'sign-in failed')
}

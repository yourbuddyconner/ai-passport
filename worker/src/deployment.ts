// Pinned facts about the verifier deployment this app trusts.
// These mirror verifier/deploy.json and the TVC deployment record; an
// independent auditor compares them against the enclave's attestation
// document (and the reproducible StageX build) to confirm the running code.
// Update when the verifier is redeployed.

export const VERIFIER_DEPLOYMENT = {
  environment: 'Turnkey Verifiable Cloud (dev)',
  appName: 'ai-passport-verifier',
  appId: 'b6be5c24-6101-4b30-8ded-86e330edb46d',
  deploymentId: '573d4a5c-d150-4e7b-abe3-b12baf0632d2',
  manifestId: 'b8c1f7f0-806a-4e3b-a2fb-0116cec9c683',
  qosVersion: '0.12.1',
  verifierVersion: '0.2.0',
  image:
    'ghcr.io/yourbuddyconner/ai-passport-verifier:v0.1.0@sha256:8f14750973bc0cf6c6d3fd4ebcab99ce3942589905bcdec4dbdfd9ca4a200d90',
  pivotPath: '/tvc_app',
  pivotSha256: 'bd4750cf5fba0bcd90ba4e85ff4b25729332718a77806c285b4243ddde6c0dec',
  enclave: 'AWS Nitro Enclave · QuorumOS',
  egress: 'disabled',
  debugMode: 'disabled',
  source: 'https://github.com/tkhq/tvc-template',
} as const

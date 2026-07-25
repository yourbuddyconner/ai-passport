// Pinned facts about the verifier deployment this app trusts.
// These mirror verifier/deploy.json and the TVC deployment record; an
// independent auditor compares them against the enclave's attestation
// document (and the reproducible StageX build) to confirm the running code.
// Update when the verifier is redeployed.

export const VERIFIER_DEPLOYMENT = {
  environment: 'Turnkey Verifiable Cloud (dev)',
  appName: 'ai-passport-verifier',
  appId: 'b6be5c24-6101-4b30-8ded-86e330edb46d',
  deploymentId: 'f83305cf-3d86-4cd1-abf0-73ccba623cb8',
  manifestId: '07fc5426-5546-428d-a6dd-a7a2463b68b2',
  qosVersion: '0.12.1',
  verifierVersion: '0.4.1',
  image:
    'ghcr.io/yourbuddyconner/ai-passport-verifier:v0.4.1@sha256:c0a0578d96ca478387f44788d64e38992402f48519487f882309dd954b920075',
  pivotPath: '/tvc_app',
  pivotSha256: '5e06341c847781b00f017c49eebea05c8dae9c51347fc46ddfe0841542213ca7',
  enclave: 'AWS Nitro Enclave · QuorumOS',
  egress: 'disabled',
  debugMode: 'disabled',
  repository: 'https://github.com/yourbuddyconner/ai-passport',
  template: 'https://github.com/tkhq/tvc-template',
} as const

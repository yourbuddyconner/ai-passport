// Pinned facts about the verifier deployment this app trusts.
// These mirror verifier/deploy.json and the TVC deployment record; an
// independent auditor compares them against the enclave's attestation
// document (and the reproducible StageX build) to confirm the running code.
// Update when the verifier is redeployed.

export const VERIFIER_DEPLOYMENT = {
  environment: 'Turnkey Verifiable Cloud (dev)',
  appName: 'ai-passport-verifier',
  appId: 'b6be5c24-6101-4b30-8ded-86e330edb46d',
  deploymentId: '79a28b26-00a5-45c2-aecf-1ad11dee515c',
  manifestId: '8251cbd6-545b-4d78-9efa-8a052bca4561',
  qosVersion: '0.12.1',
  verifierVersion: '0.5.0',
  image:
    'ghcr.io/yourbuddyconner/ai-passport-verifier:v0.5.0@sha256:269d77d3656e525cec8b99ec722067ae168a0330211fc0b923f71b93e9157081',
  pivotPath: '/tvc_app',
  pivotSha256: 'a15713a9e3db912dd14e33917ae456faecbbe067168ebca9ed75ea48c8261841',
  enclave: 'AWS Nitro Enclave · QuorumOS',
  egress: 'disabled',
  debugMode: 'disabled',
  repository: 'https://github.com/yourbuddyconner/ai-passport',
  template: 'https://github.com/tkhq/tvc-template',
} as const

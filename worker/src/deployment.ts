// Pinned facts about the verifier deployment this app trusts.
// These mirror verifier/deploy.json and the TVC deployment record; an
// independent auditor compares them against the enclave's attestation
// document (and the reproducible StageX build) to confirm the running code.
// Update when the verifier is redeployed.

export const VERIFIER_DEPLOYMENT = {
  environment: 'Turnkey Verifiable Cloud (dev)',
  appName: 'ai-passport-verifier',
  appId: 'b6be5c24-6101-4b30-8ded-86e330edb46d',
  deploymentId: '5e88cf12-2280-4429-bb3b-325ca411947d',
  manifestId: '70e60ff1-ba7d-4f81-8090-dc3e7d88c219',
  qosVersion: '0.12.1',
  verifierVersion: '0.4.2',
  image:
    'ghcr.io/yourbuddyconner/ai-passport-verifier:v0.4.2@sha256:e5334a115f46d3c9818c555ea5f8571c7fdf78d73e298a15f44c8f55af4368ad',
  pivotPath: '/tvc_app',
  pivotSha256: '0779f47acfe24284c56215955e613ed7cb4f7b518dbcb1b7a8e5060d4789311e',
  enclave: 'AWS Nitro Enclave · QuorumOS',
  egress: 'disabled',
  debugMode: 'disabled',
  repository: 'https://github.com/yourbuddyconner/ai-passport',
  template: 'https://github.com/tkhq/tvc-template',
} as const

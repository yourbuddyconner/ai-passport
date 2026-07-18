// Pinned facts about the verifier deployment this app trusts.
// These mirror verifier/deploy.json and the TVC deployment record; an
// independent auditor compares them against the enclave's attestation
// document (and the reproducible StageX build) to confirm the running code.
// Update when the verifier is redeployed.

export const VERIFIER_DEPLOYMENT = {
  environment: 'Turnkey Verifiable Cloud (dev)',
  appName: 'ai-passport-verifier',
  appId: 'b6be5c24-6101-4b30-8ded-86e330edb46d',
  deploymentId: '8f45f06d-a478-4b14-ae93-2f37db80cc64',
  manifestId: 'f4a3fee8-c9d7-49d3-a729-0fc302143c52',
  qosVersion: '0.12.1',
  verifierVersion: '0.3.0',
  image:
    'ghcr.io/yourbuddyconner/ai-passport-verifier:v0.3.0@sha256:ccf75ff4724ac14edec27350fbfdaaa7dd72c6051507b42720b752802af1ba0c',
  pivotPath: '/tvc_app',
  pivotSha256: '82ffedf0bcdada70bc90985432461163c265280204d1721bf8002d8e59f9cf76',
  enclave: 'AWS Nitro Enclave · QuorumOS',
  egress: 'disabled',
  debugMode: 'disabled',
  repository: 'https://github.com/yourbuddyconner/ai-passport',
  template: 'https://github.com/tkhq/tvc-template',
} as const

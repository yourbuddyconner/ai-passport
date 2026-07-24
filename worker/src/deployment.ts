// Pinned facts about the verifier deployment this app trusts.
// These mirror verifier/deploy.json and the TVC deployment record; an
// independent auditor compares them against the enclave's attestation
// document (and the reproducible StageX build) to confirm the running code.
// Update when the verifier is redeployed.

export const VERIFIER_DEPLOYMENT = {
  environment: 'Turnkey Verifiable Cloud (dev)',
  appName: 'ai-passport-verifier',
  appId: 'b6be5c24-6101-4b30-8ded-86e330edb46d',
  deploymentId: 'c6ef1537-f0ea-4706-aa17-ebce3c521125',
  manifestId: 'fe22eaf2-1e9b-4132-8033-4f54831f503b',
  qosVersion: '0.12.1',
  verifierVersion: '0.4.0',
  image:
    'ghcr.io/yourbuddyconner/ai-passport-verifier:v0.4.0@sha256:13ac75fc391f6b55cfa04762eb658da546ade460c8344c0a6a9771becd9f53e2',
  pivotPath: '/tvc_app',
  pivotSha256: '21540974df7900cfaece11fb6eea65e9e57481738543babc304f40d72ecf714b',
  enclave: 'AWS Nitro Enclave · QuorumOS',
  egress: 'disabled',
  debugMode: 'disabled',
  repository: 'https://github.com/yourbuddyconner/ai-passport',
  template: 'https://github.com/tkhq/tvc-template',
} as const

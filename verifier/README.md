# AI Passport Verifier (TVC enclave app)

The verifiable coprocessor for [AI Passport](../README.md), built on
[Turnkey Verifiable Cloud](https://docs.turnkey.com/features/verifiable-cloud/overview)
from the [`tkhq/tvc-template`](https://github.com/tkhq/tvc-template).

The enclave is stateless by design. All application state (passports, card
metadata, encrypted trace blobs) lives in the Cloudflare app; this service is a
pure `ciphertext in → signed verdict out` function:

1. Client encrypts `{passport_id, trace}` to the enclave's **quorum key**
   (fetch it from `GET /quorum_public_key`). The app's storage layer only ever
   sees ciphertext.
2. `POST /analyze {"ciphertext": "<hex>"}` — the enclave decrypts, parses the
   trace (Claude Code or Codex JSONL), and returns normalized session stats.
3. The response includes an **app proof**: an ephemeral-key P256 signature over
   the canonical (`qos_json`) payload `{passport_id, trace_sha256, stats,
   analyzed_at}`. The `passport_id` binding prevents replaying a proof onto
   another passport; `trace_sha256` binds it to the exact analyzed trace.

The card score is deliberately NOT computed here: the enclave signs *facts*,
and the score is a public deterministic formula over those signed facts that
anyone can recompute.

## Endpoints

- `GET /health`, `GET /time`, `GET /metrics` — template plumbing
- `GET /quorum_public_key` — key to encrypt envelopes to
- `POST /analyze` — the coprocessor endpoint (above)
- `POST /quorum_key/encrypt` / `decrypt` — kept from the template; handy for
  local testing (encrypt an envelope without client-side crypto)

## Develop

```sh
make test     # unit + integration tests (parsers, analyze round-trip, proofs)
make lint     # clippy -D warnings
make run      # local server on :44020 with generated static keys
```

The parsers mirror `worker/src/parsers/` (TypeScript); both are tested against
the same fixtures — keep them in sync.

## Build the enclave image

Requires Docker ≥ 26 with containerd snapshotter (StageX reproducible build):

```sh
make out/passport-verifier/index.json
```

Deploy with the `tvc` CLI per the
[quickstart](https://docs.turnkey.com/features/verifiable-cloud/quickstart).

## Dev deployment (Turnkey internal)

Deployed on TVC dev:

- **Ingress**: `https://app-b6be5c24-6101-4b30-8ded-86e330edb46d.apps.tvc-dev.turnkey.engineering`
- **App ID**: `b6be5c24-6101-4b30-8ded-86e330edb46d` · deployment `573d4a5c-…632d2` · 3/3 replicas
- **Image**: `ghcr.io/yourbuddyconner/ai-passport-verifier:v0.1.0` (public), pivot digest in `deploy.json`
- Login: `tvc login --api-base-url https://api.dev.turnkey.engineering` (undocumented but
  first-class; preprod: `api.preprod.turnkey.engineering`)
- The public domain is shown on the app page in the dev dashboard
  (`app-<app-id>.apps.tvc-dev.turnkey.engineering`); `tvc deploy provisioning-details`
  currently 500s on dev.
- Redeploy: bump the image tag, `make out/passport-verifier/index.json` (needs a
  `docker-container` buildx builder or the containerd image store), push with
  `docker build --output type=registry`, update `deploy.json` digests,
  `tvc deploy create` + `tvc deploy approve` (interactive TTY), then
  `tvc app set-live-deploy --deploy-id <id>` — approval alone provisions
  healthy replicas but never cuts traffic over (3/3 healthy, "Is Targeted
  Deployment: no" until you set it live). Build needs
  `BUILDX_BUILDER=tvc-builder` (plain docker driver can't export OCI).

### Gotchas discovered

- The TVC ingress sits behind a Cloudflare WAF that 403s plaintext trace content in POST
  bodies. This is why the Worker encrypts envelopes **locally** (`worker/src/qosCrypto.ts`, a
  WebCrypto port of qos_p256 ECIES) — only hex ciphertext crosses the ingress. Do not
  reintroduce a dependency on `/quorum_key/encrypt` for real traces.
- qos_p256 dual public keys are `encrypt_public(65) || sign_public(65)`; signatures are
  ECDSA P-256/SHA-256, raw r||s — both halves usable directly with WebCrypto.
- `wrangler secret put` keeps a trailing newline if you pipe with `echo` — use `printf`.

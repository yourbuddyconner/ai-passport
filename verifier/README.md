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

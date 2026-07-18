-- Enclave verification support.
-- verification: 'enclave' (analyzed inside the TVC enclave, proof present)
--             | 'format'  (parsed in the Worker, legacy/fallback path)
ALTER TABLE sessions ADD COLUMN verification TEXT NOT NULL DEFAULT 'format';
-- JSON app proof from the enclave: {public_key, payload, signature} (hex fields)
ALTER TABLE sessions ADD COLUMN proof TEXT;
-- R2 object key of the quorum-encrypted trace, kept for re-verification
ALTER TABLE sessions ADD COLUMN r2_key TEXT;

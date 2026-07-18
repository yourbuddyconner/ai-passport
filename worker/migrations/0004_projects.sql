-- Distinct-repository counting: truncated SHA-256 of each session's cwd,
-- computed inside the enclave. No paths are ever stored.
ALTER TABLE sessions ADD COLUMN project_hash TEXT;

CREATE TABLE IF NOT EXISTS passports (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  edit_token TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  passport_id TEXT NOT NULL REFERENCES passports(id),
  harness TEXT NOT NULL,
  external_id TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  models TEXT NOT NULL DEFAULT '[]',
  tool_counts TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  verification TEXT NOT NULL DEFAULT 'format',
  proof TEXT,
  r2_key TEXT,
  UNIQUE(passport_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_passport ON sessions(passport_id);

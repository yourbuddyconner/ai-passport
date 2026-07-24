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
  project_hash TEXT,
  loc_added INTEGER NOT NULL DEFAULT 0,
  loc_removed INTEGER NOT NULL DEFAULT 0,
  languages TEXT NOT NULL DEFAULT '{}',
  command_counts TEXT NOT NULL DEFAULT '{}',
  human_turns INTEGER NOT NULL DEFAULT 0,
  agenticity REAL NOT NULL DEFAULT 0,
  longest_run INTEGER NOT NULL DEFAULT 0,
  parallel_batches INTEGER NOT NULL DEFAULT 0,
  delegation_calls INTEGER NOT NULL DEFAULT 0,
  verified_edit_cycles INTEGER NOT NULL DEFAULT 0,
  red_green_cycles INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL DEFAULT '',
  skills TEXT NOT NULL DEFAULT '[]',
  mcp_servers TEXT NOT NULL DEFAULT '[]',
  background_tasks INTEGER NOT NULL DEFAULT 0,
  UNIQUE(passport_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_passport ON sessions(passport_id);

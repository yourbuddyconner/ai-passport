-- Passkey accounts. A user owns their passport; login sessions are random
-- IDs in an HttpOnly cookie (no signing needed — the ID is the secret).
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  title TEXT,
  onboarded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,              -- base64url credential ID
  user_id TEXT NOT NULL REFERENCES users(id),
  public_key TEXT NOT NULL,         -- base64url COSE public key
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credentials_user ON credentials(user_id);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  kind TEXT NOT NULL,               -- 'register' | 'login'
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_sessions_user ON login_sessions(user_id);

ALTER TABLE passports ADD COLUMN user_id TEXT REFERENCES users(id);

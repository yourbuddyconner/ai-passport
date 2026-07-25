ALTER TABLE passports ADD COLUMN listed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE passports ADD COLUMN verified_score INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS ladders (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  invite_code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES passports(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ladder_members (
  ladder_id TEXT NOT NULL REFERENCES ladders(id),
  passport_id TEXT NOT NULL REFERENCES passports(id),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (ladder_id, passport_id)
);
CREATE INDEX IF NOT EXISTS idx_passports_listed ON passports(listed, verified_score);
CREATE INDEX IF NOT EXISTS idx_ladder_members_passport ON ladder_members(passport_id);

-- Additive migration for existing stage 1 databases.
ALTER TABLE sessions ADD COLUMN admin_code_fingerprint TEXT
  CHECK (admin_code_fingerprint IS NULL OR
    (length(admin_code_fingerprint) = 64 AND admin_code_fingerprint NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE sessions ADD COLUMN member_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE;

CREATE TABLE auth_challenges (
  token_hash TEXT PRIMARY KEY NOT NULL,
  nonce_hash TEXT NOT NULL,
  csrf_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  consumed_at INTEGER,
  session_id TEXT UNIQUE,
  CHECK ((consumed_at IS NULL AND session_id IS NULL) OR
    (consumed_at IS NOT NULL AND session_id IS NOT NULL))
) STRICT;
CREATE INDEX idx_auth_challenges_expiry ON auth_challenges(expires_at);

-- Keys are hashes of scoped identifiers. Raw IPs and credentials are not stored.
CREATE TABLE auth_rate_limits (
  key_hash TEXT PRIMARY KEY NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  reset_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_auth_rate_limits_expiry ON auth_rate_limits(reset_at);

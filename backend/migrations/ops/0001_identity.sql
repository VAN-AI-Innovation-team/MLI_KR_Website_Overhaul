-- Private operational database. No records from these tables are public by default.
-- IDs are application-generated opaque UUIDs. All timestamps are UTC epoch seconds.
CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  nickname TEXT NOT NULL CHECK (length(trim(nickname)) BETWEEN 1 AND 40),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  preferred_language TEXT NOT NULL DEFAULT 'ko'
    CHECK (preferred_language IN ('ko', 'en', 'zh-CN', 'es', 'fr', 'ja')),
  terms_version TEXT NOT NULL CHECK (length(trim(terms_version)) > 0),
  privacy_version TEXT NOT NULL CHECK (length(trim(privacy_version)) > 0),
  consented_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE TABLE auth_identities (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider = 'google'),
  subject TEXT NOT NULL CHECK (length(trim(subject)) > 0),
  email TEXT NOT NULL CHECK (length(trim(email)) BETWEEN 3 AND 254),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (provider, subject),
  UNIQUE (user_id, provider)
) STRICT;
CREATE INDEX idx_auth_identities_user ON auth_identities(user_id);

-- Provision explicitly after verifying the operator's Google identity in stage 2.
-- No default administrators are inserted by migrations.
CREATE TABLE admin_memberships (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'moderator', 'consultant')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE
    CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  kind TEXT NOT NULL DEFAULT 'member' CHECK (kind IN ('member', 'admin')),
  admin_user_id TEXT REFERENCES admin_memberships(user_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK (expires_at > created_at),
  CHECK (last_seen_at >= created_at AND last_seen_at <= expires_at),
  CHECK (
    (kind = 'member' AND admin_user_id IS NULL) OR
    (kind = 'admin' AND admin_user_id IS NOT NULL AND admin_user_id = user_id)
  )
) STRICT;
CREATE INDEX idx_sessions_user ON sessions(user_id, kind);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

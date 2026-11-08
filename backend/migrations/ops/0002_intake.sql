CREATE TABLE consultations (
  id TEXT PRIMARY KEY NOT NULL,
  receipt_number TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  email TEXT NOT NULL CHECK (length(trim(email)) BETWEEN 3 AND 254),
  phone TEXT CHECK (phone IS NULL OR length(phone) <= 40),
  consultation_type TEXT NOT NULL CHECK (consultation_type IN ('individual', 'organization', 'other')),
  topic TEXT NOT NULL CHECK (length(trim(topic)) BETWEEN 1 AND 5000),
  organization TEXT CHECK (organization IS NULL OR length(organization) <= 200),
  job_title TEXT CHECK (job_title IS NULL OR length(job_title) <= 100),
  preferred_time_1 INTEGER,
  preferred_time_2 INTEGER,
  preferred_timezone TEXT NOT NULL DEFAULT 'Asia/Seoul',
  preferred_mode TEXT CHECK (preferred_mode IN ('online', 'offline')),
  preferred_language TEXT NOT NULL DEFAULT 'ko'
    CHECK (preferred_language IN ('ko', 'en', 'zh-CN', 'es', 'fr', 'ja')),
  privacy_consent_version TEXT NOT NULL CHECK (length(trim(privacy_consent_version)) > 0),
  privacy_consented_at INTEGER NOT NULL,
  marketing_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (marketing_opt_in IN (0, 1)),
  marketing_consent_version TEXT,
  marketing_consented_at INTEGER,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'reviewing', 'needs_info', 'proposed', 'confirmed', 'completed', 'cancelled')),
  assigned_admin_id TEXT REFERENCES admin_memberships(user_id) ON DELETE RESTRICT,
  internal_note TEXT NOT NULL DEFAULT '' CHECK (length(internal_note) <= 10000),
  follow_up_at INTEGER,
  confirmed_time INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  retention_until INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (
    (marketing_opt_in = 0 AND marketing_consent_version IS NULL AND marketing_consented_at IS NULL) OR
    (marketing_opt_in = 1 AND marketing_consent_version IS NOT NULL
      AND length(trim(marketing_consent_version)) > 0 AND marketing_consented_at IS NOT NULL)
  ),
  CHECK (status <> 'confirmed' OR confirmed_time IS NOT NULL)
) STRICT;
CREATE INDEX idx_consultations_recent ON consultations(created_at DESC, id);
CREATE INDEX idx_consultations_status ON consultations(status, created_at DESC);
CREATE INDEX idx_consultations_assigned ON consultations(assigned_admin_id, status, created_at DESC);
CREATE INDEX idx_consultations_type ON consultations(consultation_type, created_at DESC);
CREATE INDEX idx_consultations_email ON consultations(email);
CREATE INDEX idx_consultations_retention ON consultations(retention_until) WHERE retention_until IS NOT NULL;

CREATE TABLE inquiries (
  id TEXT PRIMARY KEY NOT NULL,
  receipt_number TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  inquiry_type TEXT NOT NULL CHECK (inquiry_type IN ('general', 'press', 'research', 'partnership', 'site_issue')),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  email TEXT NOT NULL CHECK (length(trim(email)) BETWEEN 3 AND 254),
  message TEXT NOT NULL CHECK (length(trim(message)) BETWEEN 1 AND 5000),
  preferred_language TEXT NOT NULL DEFAULT 'ko'
    CHECK (preferred_language IN ('ko', 'en', 'zh-CN', 'es', 'fr', 'ja')),
  privacy_consent_version TEXT NOT NULL CHECK (length(trim(privacy_consent_version)) > 0),
  privacy_consented_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewing', 'needs_info', 'completed', 'cancelled')),
  assigned_admin_id TEXT REFERENCES admin_memberships(user_id) ON DELETE RESTRICT,
  internal_note TEXT NOT NULL DEFAULT '' CHECK (length(internal_note) <= 10000),
  follow_up_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  retention_until INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
CREATE INDEX idx_inquiries_recent ON inquiries(created_at DESC, id);
CREATE INDEX idx_inquiries_status ON inquiries(status, created_at DESC);
CREATE INDEX idx_inquiries_assigned ON inquiries(assigned_admin_id, status, created_at DESC);
CREATE INDEX idx_inquiries_retention ON inquiries(retention_until) WHERE retention_until IS NOT NULL;

-- Store event metadata only. Never copy email, phone, topic, message, session
-- tokens, or request bodies into this table. Keep status changes in the same
-- OPS_DB batch as the corresponding audit event in the future intake API.
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'system')),
  action TEXT NOT NULL CHECK (length(trim(action)) BETWEEN 1 AND 100),
  target_type TEXT NOT NULL CHECK (target_type IN ('consultation', 'inquiry', 'post', 'comment', 'report', 'user', 'knowledge', 'session')),
  target_id TEXT NOT NULL,
  previous_state TEXT,
  next_state TEXT,
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 1000),
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
CREATE INDEX idx_audit_target ON audit_events(target_type, target_id, created_at);
CREATE INDEX idx_audit_actor ON audit_events(actor_user_id, created_at DESC);

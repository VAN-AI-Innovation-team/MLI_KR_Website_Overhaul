-- Canonical originals (including drafts, hidden and deleted records) stay private.
CREATE TABLE posts (
  id TEXT PRIMARY KEY NOT NULL,
  board_type TEXT NOT NULL CHECK (board_type IN ('community', 'notice', 'press', 'insight', 'research', 'page', 'coverage')),
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  slug TEXT NOT NULL UNIQUE CHECK (length(trim(slug)) BETWEEN 1 AND 180),
  original_language TEXT NOT NULL DEFAULT 'ko'
    CHECK (original_language IN ('ko', 'en', 'zh-CN', 'es', 'fr', 'ja')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'published', 'archived', 'hidden', 'deleted')),
  comments_enabled INTEGER NOT NULL DEFAULT 0 CHECK (comments_enabled IN (0, 1)),
  is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1)),
  public_moderation_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  published_at INTEGER,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (status <> 'published' OR published_at IS NOT NULL),
  CHECK ((status = 'deleted' AND deleted_at IS NOT NULL) OR (status <> 'deleted' AND deleted_at IS NULL))
) STRICT;
CREATE INDEX idx_posts_board_status ON posts(board_type, status, published_at DESC);
CREATE INDEX idx_posts_author ON posts(author_id, created_at DESC);

CREATE TABLE post_translations (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  locale TEXT NOT NULL CHECK (locale IN ('ko', 'en', 'zh-CN', 'es', 'fr', 'ja')),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  summary TEXT NOT NULL DEFAULT '' CHECK (length(summary) <= 1000),
  body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 100000),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'approved')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  reviewed_by TEXT REFERENCES admin_memberships(user_id) ON DELETE RESTRICT,
  approved_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (post_id, locale),
  CHECK (status <> 'approved' OR (reviewed_by IS NOT NULL AND approved_at IS NOT NULL))
) STRICT;

CREATE TABLE post_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  post_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT NOT NULL,
  editor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (post_id, locale) REFERENCES post_translations(post_id, locale) ON DELETE CASCADE,
  UNIQUE (post_id, locale, version)
) STRICT;

CREATE TABLE comments (
  id TEXT PRIMARY KEY NOT NULL,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  locale TEXT NOT NULL DEFAULT 'ko' CHECK (locale IN ('ko', 'en', 'zh-CN', 'es', 'fr', 'ja')),
  body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 3000),
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden', 'deleted')),
  public_moderation_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK ((status = 'deleted' AND deleted_at IS NOT NULL) OR (status <> 'deleted' AND deleted_at IS NULL))
) STRICT;
CREATE INDEX idx_comments_post ON comments(post_id, status, created_at);
CREATE INDEX idx_comments_author ON comments(author_id, created_at DESC);

CREATE TABLE reports (
  id TEXT PRIMARY KEY NOT NULL,
  reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
  comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewing', 'resolved', 'dismissed')),
  resolved_by TEXT REFERENCES admin_memberships(user_id) ON DELETE RESTRICT,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK ((post_id IS NOT NULL AND comment_id IS NULL) OR (post_id IS NULL AND comment_id IS NOT NULL)),
  CHECK (status NOT IN ('resolved', 'dismissed') OR (resolved_by IS NOT NULL AND resolved_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX idx_reports_post_once ON reports(reporter_id, post_id) WHERE post_id IS NOT NULL;
CREATE UNIQUE INDEX idx_reports_comment_once ON reports(reporter_id, comment_id) WHERE comment_id IS NOT NULL;
CREATE INDEX idx_reports_status ON reports(status, created_at);

CREATE TABLE moderation_actions (
  id TEXT PRIMARY KEY NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  moderator_id TEXT NOT NULL REFERENCES admin_memberships(user_id) ON DELETE RESTRICT,
  post_id TEXT REFERENCES posts(id) ON DELETE RESTRICT,
  comment_id TEXT REFERENCES comments(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('hide', 'restore', 'delete')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  previous_status TEXT NOT NULL,
  next_status TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK ((post_id IS NOT NULL AND comment_id IS NULL) OR (post_id IS NULL AND comment_id IS NOT NULL))
) STRICT;
CREATE INDEX idx_moderation_post ON moderation_actions(post_id, created_at);
CREATE INDEX idx_moderation_comment ON moderation_actions(comment_id, created_at);

CREATE TABLE knowledge_documents (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 300),
  source_url TEXT NOT NULL CHECK (source_url LIKE 'https://%'),
  source_type TEXT NOT NULL CHECK (source_type IN ('official', 'paper', 'patent', 'cv', 'press', 'other')),
  locale TEXT NOT NULL CHECK (locale IN ('ko', 'en', 'zh-CN', 'es', 'fr', 'ja')),
  source_locator TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  allowed_claims TEXT NOT NULL DEFAULT '',
  rights_status TEXT NOT NULL DEFAULT 'pending' CHECK (rights_status IN ('pending', 'cleared', 'denied')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'approved', 'archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  reviewed_by TEXT REFERENCES admin_memberships(user_id) ON DELETE RESTRICT,
  approved_at INTEGER,
  valid_until INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (status <> 'approved' OR (rights_status = 'cleared' AND reviewed_by IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK (valid_until IS NULL OR approved_at IS NULL OR valid_until > approved_at)
) STRICT;
CREATE INDEX idx_knowledge_review ON knowledge_documents(status, locale);

-- Future publishing writes this outbox together with the canonical edit in ONE
-- OPS_DB batch. Delivery into CONTENT_DB is separate and must be retried safely.
-- No cross-database transaction or publisher is implemented in stage 1.
CREATE TABLE publication_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'comment', 'knowledge')),
  target_id TEXT NOT NULL,
  target_version INTEGER NOT NULL CHECK (target_version > 0),
  operation TEXT NOT NULL CHECK (operation IN ('sync', 'remove')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code TEXT,
  available_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (target_type, target_id, target_version)
) STRICT;
CREATE INDEX idx_publication_pending ON publication_jobs(status, available_at);

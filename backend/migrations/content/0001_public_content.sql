-- Public projection database. Populate only explicit, reviewed public fields.
-- Never import OPS_DB wholesale or expose a generic SELECT * API.
CREATE TABLE published_posts (
  id TEXT PRIMARY KEY NOT NULL,
  board_type TEXT NOT NULL CHECK (board_type IN ('community', 'notice', 'press', 'insight', 'research', 'page', 'coverage')),
  slug TEXT NOT NULL UNIQUE CHECK (length(trim(slug)) BETWEEN 1 AND 180),
  author_display_name TEXT NOT NULL,
  original_language TEXT NOT NULL CHECK (original_language IN ('ko', 'en', 'zh-CN', 'es', 'fr', 'ja')),
  comments_enabled INTEGER NOT NULL DEFAULT 0 CHECK (comments_enabled IN (0, 1)),
  is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1)),
  source_version INTEGER NOT NULL CHECK (source_version > 0),
  published_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_published_posts_board ON published_posts(board_type, is_pinned DESC, published_at DESC);

CREATE TABLE published_post_translations (
  post_id TEXT NOT NULL REFERENCES published_posts(id) ON DELETE CASCADE,
  locale TEXT NOT NULL CHECK (locale IN ('ko', 'en', 'zh-CN', 'es', 'fr', 'ja')),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  summary TEXT NOT NULL DEFAULT '' CHECK (length(summary) <= 1000),
  body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 100000),
  source_version INTEGER NOT NULL CHECK (source_version > 0),
  PRIMARY KEY (post_id, locale)
) STRICT;

CREATE TABLE published_comments (
  id TEXT PRIMARY KEY NOT NULL,
  post_id TEXT NOT NULL REFERENCES published_posts(id) ON DELETE CASCADE,
  author_display_name TEXT NOT NULL,
  locale TEXT NOT NULL CHECK (locale IN ('ko', 'en', 'zh-CN', 'es', 'fr', 'ja')),
  body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 3000),
  source_version INTEGER NOT NULL CHECK (source_version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_published_comments_post ON published_comments(post_id, created_at);

CREATE TABLE sources (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL CHECK (url LIKE 'https://%'),
  publisher TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('official', 'paper', 'patent', 'cv', 'press', 'other')),
  original_language TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  checked_at INTEGER NOT NULL
) STRICT;

-- Only approved material belongs here. Drafts and reviewer identities live in OPS_DB.
CREATE TABLE knowledge_chunks (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_version INTEGER NOT NULL CHECK (source_version > 0),
  locale TEXT NOT NULL CHECK (locale IN ('ko', 'en', 'zh-CN', 'es', 'fr', 'ja')),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  title TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  source_locator TEXT NOT NULL,
  allowed_claims TEXT NOT NULL DEFAULT '',
  approval_reference TEXT NOT NULL CHECK (length(trim(approval_reference)) > 0),
  approved_at INTEGER NOT NULL,
  valid_until INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  CHECK (valid_until IS NULL OR valid_until > approved_at),
  UNIQUE (source_id, source_version, locale, chunk_index)
) STRICT;
CREATE INDEX idx_knowledge_source ON knowledge_chunks(source_id, source_version);
CREATE INDEX idx_knowledge_locale ON knowledge_chunks(locale, is_active);

-- Inactive/expired/superseded sources must not be used by the later RAG service.
CREATE VIEW searchable_knowledge AS
SELECT k.id, k.source_id, k.source_version, k.locale, k.chunk_index,
       k.title, k.body, k.source_locator, k.allowed_claims,
       k.approved_at, s.url AS source_url, s.publisher
FROM knowledge_chunks AS k
JOIN sources AS s ON s.id = k.source_id AND s.version = k.source_version
WHERE k.is_active = 1 AND s.is_active = 1
  AND k.approved_at <= unixepoch()
  AND (k.valid_until IS NULL OR k.valid_until > unixepoch());

CREATE TABLE route_registry (
  id TEXT PRIMARY KEY NOT NULL,
  route_key TEXT NOT NULL,
  locale TEXT NOT NULL CHECK (locale IN ('ko', 'en', 'zh-CN', 'es', 'fr', 'ja')),
  path TEXT NOT NULL CHECK (substr(path, 1, 1) = '/' AND substr(path, 1, 2) <> '//'
    AND instr(path, ':') = 0 AND instr(path, char(92)) = 0
    AND instr(path, '?') = 0 AND instr(path, '#') = 0
    AND instr(path, char(10)) = 0 AND instr(path, char(13)) = 0),
  label TEXT NOT NULL,
  description TEXT NOT NULL,
  required_role TEXT NOT NULL DEFAULT 'public' CHECK (required_role IN ('public', 'member', 'admin')),
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  UNIQUE (route_key, locale),
  UNIQUE (path)
) STRICT;
CREATE VIEW public_routes AS
SELECT route_key, locale, path, label, description
FROM route_registry WHERE is_active = 1 AND required_role = 'public';

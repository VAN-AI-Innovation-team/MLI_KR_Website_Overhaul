import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

function database(t, kind) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const directory = new URL(`../migrations/${kind}/`, import.meta.url);
  for (const file of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, directory), 'utf8'));
  }
  t.after(() => db.close());
  return db;
}

function insert(db, table, values) {
  const columns = Object.keys(values);
  return db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...Object.values(values));
}

function user(db, id = 'member') {
  insert(db, 'users', {
    id, nickname: `테스트 ${id}`, terms_version: 'test-v1', privacy_version: 'test-v1', consented_at: 1,
  });
  return id;
}

function admin(db, id = 'operator') {
  user(db, id);
  insert(db, 'admin_memberships', { user_id: id, role: 'admin' });
  return id;
}

function consultation(overrides = {}) {
  return {
    id: 'consultation-1', receipt_number: 'TEST-C-1', idempotency_key: 'test-request-key-1',
    request_hash: 'a'.repeat(64), name: '테스트 신청자', email: 'applicant@example.invalid',
    consultation_type: 'individual', topic: '테스트용 리더십 질문',
    privacy_consent_version: 'test-privacy-v1', privacy_consented_at: 1, ...overrides,
  };
}

function post(db, overrides = {}) {
  insert(db, 'posts', { id: 'post-1', board_type: 'community', author_id: 'member', slug: 'test-post', ...overrides });
}

function publicPost(db) {
  insert(db, 'published_posts', {
    id: 'post-1', board_type: 'notice', slug: 'test-notice', author_display_name: 'MLI 테스트',
    original_language: 'ko', source_version: 1, published_at: 1, updated_at: 1,
  });
}

test('migrations create separate databases without seeding personal data or administrators', t => {
  const ops = database(t, 'ops');
  const content = database(t, 'content');
  assert.equal(ops.prepare('SELECT count(*) AS n FROM users').get().n, 0);
  assert.equal(ops.prepare('SELECT count(*) AS n FROM admin_memberships').get().n, 0);
  assert.equal(content.prepare('SELECT count(*) AS n FROM published_posts').get().n, 0);
  for (const table of ['users', 'auth_identities', 'sessions', 'consultations', 'inquiries', 'audit_events', 'post_revisions']) {
    assert.equal(content.prepare('SELECT count(*) AS n FROM sqlite_schema WHERE name = ?').get(table).n, 0);
  }
  assert.deepEqual(ops.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(content.prepare('PRAGMA foreign_key_check').all(), []);
});

test('Google subject cannot belong to two different users', t => {
  const db = database(t, 'ops');
  user(db, 'a'); user(db, 'b');
  insert(db, 'auth_identities', { id: 'identity-a', user_id: 'a', provider: 'google', subject: 'same-google-sub', email: 'a@example.invalid' });
  assert.throws(() => insert(db, 'auth_identities', { id: 'identity-b', user_id: 'b', provider: 'google', subject: 'same-google-sub', email: 'b@example.invalid' }), /UNIQUE/);
});

test('admin sessions require the same user to have an administrator membership', t => {
  const db = database(t, 'ops');
  user(db);
  const now = Math.floor(Date.now() / 1000);
  const session = { id: 's1', user_id: 'member', kind: 'admin', token_hash: 'a'.repeat(64), created_at: now, last_seen_at: now, expires_at: now + 1800 };
  assert.throws(() => insert(db, 'sessions', session), /CHECK/);
  assert.throws(() => insert(db, 'sessions', { ...session, admin_user_id: 'member' }), /FOREIGN KEY/);
  admin(db);
  assert.throws(() => insert(db, 'sessions', { ...session, admin_user_id: 'operator' }), /CHECK/);
  insert(db, 'sessions', { ...session, user_id: 'operator', admin_user_id: 'operator' });
});

test('session table rejects plaintext tokens and already-expired sessions', t => {
  const db = database(t, 'ops');
  user(db);
  const session = { id: 's1', user_id: 'member', token_hash: 'raw-session-token', created_at: 10, last_seen_at: 10, expires_at: 20 };
  assert.throws(() => insert(db, 'sessions', session), /CHECK/);
  assert.throws(() => insert(db, 'sessions', { ...session, token_hash: 'a'.repeat(64), expires_at: 10 }), /CHECK/);
});

test('anonymous consultations default to new and do not imply a booking or marketing consent', t => {
  const db = database(t, 'ops');
  insert(db, 'consultations', consultation());
  const record = db.prepare('SELECT * FROM consultations').get();
  assert.equal(record.status, 'new');
  assert.equal(record.marketing_opt_in, 0);
  assert.equal(record.marketing_consented_at, null);
  assert.equal(record.confirmed_time, null);
  assert.equal(record.assigned_admin_id, null);
});

test('repeated idempotency keys and receipt numbers are rejected', t => {
  const db = database(t, 'ops');
  insert(db, 'consultations', consultation());
  assert.throws(() => insert(db, 'consultations', consultation({ id: 'c2', receipt_number: 'TEST-C-2' })), /UNIQUE/);
  assert.throws(() => insert(db, 'consultations', consultation({ id: 'c2', idempotency_key: 'test-request-key-2' })), /UNIQUE/);
});

test('consultations require privacy consent evidence, bounded input, and a known state', t => {
  const db = database(t, 'ops');
  assert.throws(() => insert(db, 'consultations', consultation({ privacy_consent_version: null })), /NOT NULL/);
  assert.throws(() => insert(db, 'consultations', consultation({ privacy_consent_version: ' ' })), /CHECK/);
  assert.throws(() => insert(db, 'consultations', consultation({ topic: 'x'.repeat(5001) })), /CHECK/);
  assert.throws(() => insert(db, 'consultations', consultation({ status: 'anything' })), /CHECK/);
});

test('marketing consent requires its own version and timestamp', t => {
  const db = database(t, 'ops');
  assert.throws(() => insert(db, 'consultations', consultation({ marketing_opt_in: 1 })), /CHECK/);
  insert(db, 'consultations', consultation({ marketing_opt_in: 1, marketing_consent_version: 'test-news-v1', marketing_consented_at: 1 }));
});

test('confirmed appointments require a confirmed time, and assignees must be operators', t => {
  const db = database(t, 'ops');
  user(db);
  assert.throws(() => insert(db, 'consultations', consultation({ status: 'confirmed' })), /CHECK/);
  assert.throws(() => insert(db, 'consultations', consultation({ assigned_admin_id: 'member' })), /FOREIGN KEY/);
  admin(db);
  insert(db, 'consultations', consultation({ status: 'confirmed', confirmed_time: 2000000000, assigned_admin_id: 'operator' }));
});

test('Contact supports only declared categories and requires consent', t => {
  const db = database(t, 'ops');
  const inquiry = {
    id: 'i1', receipt_number: 'TEST-I-1', idempotency_key: 'test-inquiry-key-1', request_hash: 'b'.repeat(64),
    inquiry_type: 'research', name: '테스트 문의자', email: 'contact@example.invalid', message: '연구 협업 테스트',
    privacy_consent_version: 'test-v1', privacy_consented_at: 1,
  };
  assert.throws(() => insert(db, 'inquiries', { ...inquiry, inquiry_type: 'unsupported' }), /CHECK/);
  assert.throws(() => insert(db, 'inquiries', { ...inquiry, privacy_consented_at: null }), /NOT NULL/);
  insert(db, 'inquiries', inquiry);
});

test('posts and comments cannot reference nonexistent authors', t => {
  const db = database(t, 'ops');
  assert.throws(() => post(db), /FOREIGN KEY/);
  user(db); post(db);
  assert.throws(() => insert(db, 'comments', { id: 'c1', post_id: 'post-1', author_id: 'other', body: '테스트 댓글' }), /FOREIGN KEY/);
  assert.throws(() => db.prepare('DELETE FROM users WHERE id = ?').run('member'), /FOREIGN KEY/);
});

test('official translation approval requires an operator and approval timestamp', t => {
  const db = database(t, 'ops');
  user(db); post(db); admin(db);
  const translation = { post_id: 'post-1', locale: 'ko', title: '테스트 제목', body: '테스트 본문', status: 'approved' };
  assert.throws(() => insert(db, 'post_translations', translation), /CHECK/);
  insert(db, 'post_translations', { ...translation, reviewed_by: 'operator', approved_at: 1 });
  assert.throws(() => insert(db, 'post_translations', { ...translation, reviewed_by: 'operator', approved_at: 1 }), /UNIQUE/);
});

test('reports have exactly one existing target and duplicate reports are rejected', t => {
  const db = database(t, 'ops');
  user(db); post(db);
  insert(db, 'comments', { id: 'c1', post_id: 'post-1', author_id: 'member', body: '댓글 테스트' });
  const report = { id: 'r1', reporter_id: 'member', reason: '테스트 신고 사유' };
  assert.throws(() => insert(db, 'reports', report), /CHECK/);
  assert.throws(() => insert(db, 'reports', { ...report, post_id: 'post-1', comment_id: 'c1' }), /CHECK/);
  insert(db, 'reports', { ...report, post_id: 'post-1' });
  assert.throws(() => insert(db, 'reports', { ...report, id: 'r2', post_id: 'post-1' }), /UNIQUE/);
});

test('knowledge cannot be approved before rights and reviewer checks', t => {
  const db = database(t, 'ops');
  admin(db);
  const document = {
    id: 'k1', title: '테스트 자료', source_url: 'https://example.invalid/theory', source_type: 'official',
    locale: 'ko', source_locator: '테스트 1절', body: '테스트 원문', status: 'approved',
  };
  assert.throws(() => insert(db, 'knowledge_documents', document), /CHECK/);
  assert.throws(() => insert(db, 'knowledge_documents', { ...document, reviewed_by: 'operator', approved_at: 1 }), /CHECK/);
  insert(db, 'knowledge_documents', { ...document, rights_status: 'cleared', reviewed_by: 'operator', approved_at: 1 });
});

test('public tables contain no identity, session, contact, or internal-note columns', t => {
  const db = database(t, 'content');
  const forbidden = new Set(['email', 'phone', 'subject', 'user_id', 'author_id', 'token_hash', 'internal_note', 'reviewed_by', 'privacy_consent_version']);
  for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()) {
    for (const { name: column } of db.prepare(`PRAGMA table_info(${name})`).all()) {
      assert.equal(forbidden.has(column), false, `${name}.${column} must stay private`);
    }
  }
});

test('removing a published post also removes its public translations and comments', t => {
  const db = database(t, 'content');
  publicPost(db);
  insert(db, 'published_post_translations', { post_id: 'post-1', locale: 'ko', title: '테스트', body: '본문', source_version: 1 });
  insert(db, 'published_comments', { id: 'c1', post_id: 'post-1', author_display_name: '테스트', locale: 'ko', body: '댓글', source_version: 1, created_at: 1, updated_at: 1 });
  db.prepare('DELETE FROM published_posts WHERE id = ?').run('post-1');
  assert.equal(db.prepare('SELECT count(*) AS n FROM published_post_translations').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM published_comments').get().n, 0);
});

test('AI search excludes inactive, expired, future-approved and superseded material', t => {
  const db = database(t, 'content');
  const now = Math.floor(Date.now() / 1000);
  insert(db, 'sources', { id: 'source-1', title: '테스트 원문', url: 'https://example.invalid/source', publisher: '테스트', source_type: 'official', original_language: 'en', version: 2, checked_at: now });
  const chunk = { source_id: 'source-1', source_version: 2, locale: 'ko', title: '테스트 카드', body: '검수된 테스트 내용', source_locator: '1절', approval_reference: 'test-approval-1', approved_at: now - 100 };
  insert(db, 'knowledge_chunks', { ...chunk, id: 'valid', chunk_index: 0 });
  insert(db, 'knowledge_chunks', { ...chunk, id: 'inactive', chunk_index: 1, is_active: 0 });
  insert(db, 'knowledge_chunks', { ...chunk, id: 'expired', chunk_index: 2, valid_until: now - 1 });
  insert(db, 'knowledge_chunks', { ...chunk, id: 'superseded', source_version: 1, chunk_index: 0 });
  insert(db, 'knowledge_chunks', { ...chunk, id: 'future', chunk_index: 3, approved_at: now + 100 });
  assert.deepEqual(db.prepare('SELECT id FROM searchable_knowledge').all().map(row => row.id), ['valid']);
  db.prepare('UPDATE sources SET is_active = 0 WHERE id = ?').run('source-1');
  assert.equal(db.prepare('SELECT count(*) AS n FROM searchable_knowledge').get().n, 0);
});

test('AI route view excludes inactive and privileged routes and blocks external URLs', t => {
  const db = database(t, 'content');
  const route = { locale: 'ko', label: '테스트 경로', description: '테스트 안내' };
  insert(db, 'route_registry', { ...route, id: 'home', route_key: 'home', path: '/ko/', is_active: 1 });
  insert(db, 'route_registry', { ...route, id: 'draft', route_key: 'draft', path: '/ko/not-ready' });
  insert(db, 'route_registry', { ...route, id: 'admin', route_key: 'admin', path: '/admin', required_role: 'admin', is_active: 1 });
  assert.deepEqual(db.prepare('SELECT path FROM public_routes').all().map(row => row.path), ['/ko/']);
  for (const path of ['https://example.invalid', '//example.invalid', '/\\example.invalid', '/javascript:alert(1)', '/ko/\n']) {
    assert.throws(() => insert(db, 'route_registry', { ...route, id: 'bad', route_key: 'bad', path }), /CHECK/);
  }
});

test('publishing outbox deduplicates a content version while allowing newer versions', t => {
  const db = database(t, 'ops');
  const job = { id: 'job-1', target_type: 'post', target_id: 'post-1', target_version: 1, operation: 'sync' };
  insert(db, 'publication_jobs', job);
  assert.throws(() => insert(db, 'publication_jobs', { ...job, id: 'job-2' }), /UNIQUE/);
  insert(db, 'publication_jobs', { ...job, id: 'job-2', target_version: 2, operation: 'remove' });
});

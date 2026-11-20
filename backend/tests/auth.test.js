import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createWorker } from '../src/worker.js';
import { requireAdmin } from '../src/auth.js';
import { ADMIN_IDLE, ADMIN_TTL, MEMBER_TTL, sha256 } from '../src/http.js';

const signingKeys = await generateKeyPair('RS256');
const otherKeys = await generateKeyPair('RS256');
const publicJwk = { ...await exportJWK(signingKeys.publicKey), kid: 'test-key', alg: 'RS256' };
const resolver = createLocalJWKSet({ keys: [publicJwk] });
const TEST_CODE = 'test-only-admin-code-with-32-or-more-characters';

function d1(db) {
  function prepare(sql, parameters = []) {
    return {
      bind: (...values) => prepare(sql, values),
      execute() {
        const results = db.prepare(sql).all(...parameters);
        const changes = /^\s*(INSERT|UPDATE|DELETE)/i.test(sql)
          ? db.prepare('SELECT changes() AS n').get().n : 0;
        return { success: true, results, meta: { changes } };
      },
      async first() { return this.execute().results[0] ?? null; },
      async all() { return this.execute(); },
      async run() { return this.execute(); },
    };
  }
  return {
    prepare,
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = statements.map(statement => statement.execute());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function database(t, kind, through = null) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const directory = new URL(`../migrations/${kind}/`, import.meta.url);
  for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
    if (!through || name <= through) db.exec(readFileSync(new URL(name, directory), 'utf8'));
  }
  t.after(() => db.close());
  return db;
}

async function fixture(t) {
  const ops = database(t, 'ops');
  const content = database(t, 'content');
  const state = { now: 1_800_000_000 };
  const env = {
    OPS_DB: d1(ops), CONTENT_DB: d1(content), APP_ORIGIN: 'https://mli.example',
    GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com', TERMS_VERSION: 'test-terms-v1',
    PRIVACY_VERSION: 'test-privacy-v1', ADMIN_GOOGLE_SUBJECTS: 'account-a',
    ADMIN_CODE_SHA256: await sha256(TEST_CODE),
  };
  const worker = createWorker({ googleKeys: resolver, clock: () => state.now });
  return { ops, content, state, env, worker };
}

function browser(f) {
  const cookies = new Map();
  return {
    cookies,
    async call(path, { method = 'GET', body, csrf, origin = f.env.APP_ORIGIN, headers = {} } = {}) {
      const requestHeaders = new Headers(headers);
      if (origin !== null) requestHeaders.set('Origin', origin);
      if (cookies.size) requestHeaders.set('Cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '));
      if (csrf) requestHeaders.set('X-CSRF-Token', csrf);
      if (body !== undefined && !requestHeaders.has('Content-Type')) requestHeaders.set('Content-Type', 'application/json');
      const response = await f.worker.fetch(new Request(`${f.env.APP_ORIGIN}${path}`, {
        method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body),
      }), f.env);
      for (const cookie of response.headers.getSetCookie()) {
        const [name, value] = cookie.split(';')[0].split('=');
        if (cookie.includes('Max-Age=0;') || cookie.endsWith('Max-Age=0')) cookies.delete(name);
        else cookies.set(name, value);
      }
      return { response, body: await response.json() };
    },
  };
}

async function token(f, nonce, claims = {}, privateKey = signingKeys.privateKey) {
  return new SignJWT({
    iss: 'https://accounts.google.com', aud: f.env.GOOGLE_CLIENT_ID, sub: 'account-a',
    email: 'member@example.invalid', email_verified: true, nonce,
    iat: f.state.now, exp: f.state.now + 600, ...claims,
  }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(privateKey);
}

const registration = {
  nickname: '테스트 회원', preferredLanguage: 'ko',
  consent: { terms: true, privacy: true, termsVersion: 'test-terms-v1', privacyVersion: 'test-privacy-v1' },
};

async function loginInput(f, b, claims = {}, privateKey) {
  const challenge = await b.call('/api/auth/challenge', { method: 'POST' });
  assert.equal(challenge.response.status, 200);
  return { credential: await token(f, challenge.body.nonce, claims, privateKey),
    csrfToken: challenge.body.csrfToken, registration: structuredClone(registration) };
}

async function login(f, b, claims = {}) {
  const result = await b.call('/api/auth/google', { method: 'POST', body: await loginInput(f, b, claims) });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body;
}

function provisionAdmin(f, userId, role = 'admin') {
  f.ops.prepare('INSERT INTO admin_memberships (user_id, role) VALUES (?, ?)').run(userId, role);
}

async function adminLogin(f, b, member) {
  const result = await b.call('/api/admin/session', { method: 'POST', body: { code: TEST_CODE }, csrf: member.csrfToken });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body;
}

test('stage 2 migration preserves stage 1 users and health detects a missing upgrade', async t => {
  const ops = database(t, 'ops', '0003_editorial.sql');
  ops.prepare(`INSERT INTO users (id, nickname, terms_version, privacy_version, consented_at)
    VALUES ('existing', '기존 회원', 'old', 'old', 1)`).run();
  const f = await fixture(t);
  f.env.OPS_DB = d1(ops);
  assert.equal((await browser(f).call('/api/health')).response.status, 503);
  ops.exec(readFileSync(new URL('../migrations/ops/0004_authentication.sql', import.meta.url), 'utf8'));
  assert.equal(ops.prepare("SELECT nickname FROM users WHERE id = 'existing'").get().nickname, '기존 회원');
  assert.equal((await browser(f).call('/api/health')).response.status, 503);
  ops.exec(readFileSync(new URL('../migrations/ops/0006_intake_protection.sql', import.meta.url), 'utf8'));
  assert.deepEqual((await browser(f).call('/api/health')).body, { status: 'ok', stage: 3 });
});

test('Google signup verifies a signed token, records consent and stores only hashed tokens', async t => {
  const f = await fixture(t);
  const b = browser(f);
  const input = await loginInput(f, b);
  const result = await b.call('/api/auth/google', { method: 'POST', body: input });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.expiresAt, f.state.now + MEMBER_TTL);
  const cookie = result.response.headers.getSetCookie().find(value => value.startsWith('__Host-mli_session='));
  for (const attribute of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']) assert.ok(cookie.includes(attribute));
  const stored = f.ops.prepare('SELECT * FROM sessions').get();
  assert.equal(stored.token_hash, await sha256(b.cookies.get('__Host-mli_session')));
  assert.equal(f.ops.prepare('SELECT consented_at FROM users').get().consented_at, f.state.now);
  assert.equal(f.ops.prepare('SELECT subject FROM auth_identities').get().subject, 'account-a');
  assert.equal((await b.call('/api/me')).body.user.id, result.body.user.id);
  const storedText = JSON.stringify(f.ops.prepare('SELECT * FROM audit_events').all());
  assert.ok(!storedText.includes(input.credential) && !storedText.includes(TEST_CODE));
});

test('tokens with bad signatures, claims, nonce, or email verification are rejected', async t => {
  const invalid = [
    { claims: {}, key: otherKeys.privateKey },
    { claims: { aud: 'another-client.apps.googleusercontent.com' } },
    { claims: { iss: 'https://attacker.invalid' } },
    { claims: { exp: 1_799_999_990 } },
    { claims: { iat: 1_800_000_100 } },
    { claims: { email_verified: false } },
    { claims: { nonce: 'a-nonce-from-another-browser' } },
    { claims: { azp: 'another-client.apps.googleusercontent.com' } },
    { claims: { sub: '' } },
    { claims: { exp: undefined } },
  ];
  for (const item of invalid) {
    const f = await fixture(t);
    const b = browser(f);
    const body = await loginInput(f, b, item.claims, item.key);
    const result = await b.call('/api/auth/google', { method: 'POST', body });
    assert.equal(result.response.status, 401, JSON.stringify(item.claims));
    assert.equal(f.ops.prepare('SELECT count(*) AS n FROM users').get().n, 0);
  }
});

test('new users must explicitly accept current policies and retry the same challenge after consent', async t => {
  const f = await fixture(t);
  const b = browser(f);
  const input = await loginInput(f, b);
  const missing = { ...input, registration: undefined };
  assert.equal((await b.call('/api/auth/google', { method: 'POST', body: missing })).response.status, 428);
  input.registration.consent.privacyVersion = 'outdated';
  assert.equal((await b.call('/api/auth/google', { method: 'POST', body: input })).response.status, 428);
  input.registration.consent.privacyVersion = 'test-privacy-v1';
  assert.equal((await b.call('/api/auth/google', { method: 'POST', body: input })).response.status, 200);
});

test('login challenges are browser-bound, expire, and cannot be replayed', async t => {
  const f = await fixture(t);
  const b = browser(f);
  const input = await loginInput(f, b);
  assert.equal((await browser(f).call('/api/auth/google', { method: 'POST', body: input })).response.status, 403);
  assert.equal((await b.call('/api/auth/google', { method: 'POST', body: { ...input, csrfToken: 'wrong' } })).response.status, 403);
  const oldCookie = b.cookies.get('__Host-mli_login');
  assert.equal((await b.call('/api/auth/google', { method: 'POST', body: input })).response.status, 200);
  b.cookies.set('__Host-mli_login', oldCookie);
  assert.equal((await b.call('/api/auth/google', { method: 'POST', body: input })).response.status, 403);
  const later = await loginInput(f, b);
  f.state.now += 601;
  assert.equal((await b.call('/api/auth/google', { method: 'POST', body: later })).response.status, 403);
});

test('concurrent challenge replay creates exactly one user and one session', async t => {
  const f = await fixture(t);
  const b = browser(f);
  const input = await loginInput(f, b);
  const results = await Promise.all([1, 2].map(() => b.call('/api/auth/google', { method: 'POST', body: input })));
  assert.equal(results.filter(result => result.response.status === 200).length, 1);
  assert.equal(f.ops.prepare('SELECT count(*) AS n FROM sessions').get().n, 1);
  assert.equal(f.ops.prepare('SELECT count(*) AS n FROM users').get().n, 1);
});

test('simultaneous first logins of one Google subject never leave orphan users', async t => {
  const f = await fixture(t);
  const a = browser(f);
  const b = browser(f);
  const bodies = await Promise.all([loginInput(f, a), loginInput(f, b)]);
  const results = await Promise.all([a.call('/api/auth/google', { method: 'POST', body: bodies[0] }),
    b.call('/api/auth/google', { method: 'POST', body: bodies[1] })]);
  assert.deepEqual(results.map(result => result.response.status), [200, 200]);
  assert.equal(f.ops.prepare('SELECT count(*) AS n FROM users').get().n, 1);
  assert.equal(f.ops.prepare('SELECT count(*) AS n FROM sessions').get().n, 2);
});

test('identity uses subject, while repeat login rotates sessions and updates verified email', async t => {
  const f = await fixture(t);
  const b = browser(f);
  const first = await login(f, b);
  const old = browser(f);
  old.cookies.set('__Host-mli_session', b.cookies.get('__Host-mli_session'));
  const second = await login(f, b, { email: 'changed@example.invalid' });
  assert.equal(first.user.id, second.user.id);
  assert.equal((await old.call('/api/me')).response.status, 401);
  assert.equal(f.ops.prepare('SELECT email FROM auth_identities').get().email, 'changed@example.invalid');
  const sameEmail = await login(f, browser(f), { sub: 'account-b', email: 'changed@example.invalid' });
  assert.notEqual(sameEmail.user.id, first.user.id);
});

test('profile changes require Origin, CSRF, valid fields, and an active session', async t => {
  const f = await fixture(t);
  const b = browser(f);
  const member = await login(f, b);
  assert.equal((await b.call('/api/me', { method: 'PATCH', body: { nickname: '수정' } })).response.status, 403);
  for (const origin of [null, 'https://attacker.invalid']) {
    assert.equal((await b.call('/api/me', { method: 'PATCH', body: { nickname: '수정' }, csrf: member.csrfToken, origin })).response.status, 403);
  }
  for (const body of [{ role: 'admin' }, { status: 'active' }, { nickname: '' }, { preferredLanguage: 'xx' }]) {
    assert.equal((await b.call('/api/me', { method: 'PATCH', body, csrf: member.csrfToken })).response.status, 400);
  }
  const result = await b.call('/api/me', { method: 'PATCH', body: { nickname: '새 닉네임', preferredLanguage: 'en' }, csrf: member.csrfToken });
  assert.equal(result.body.user.nickname, '새 닉네임');
  assert.equal(result.body.user.preferredLanguage, 'en');
  assert.equal((await browser(f).call('/api/me')).response.status, 401);
  f.ops.prepare("UPDATE users SET status = 'suspended'").run();
  assert.equal((await b.call('/api/me')).response.status, 403);
});

test('my activity filters by session owner and suppresses deleted content and private parent links', async t => {
  const f = await fixture(t);
  const a = browser(f);
  const b = browser(f);
  const alice = await login(f, a);
  const bob = await login(f, b, { sub: 'account-b' });
  const insertPost = f.ops.prepare(`INSERT INTO posts (id, board_type, author_id, slug, status, deleted_at)
    VALUES (?, 'community', ?, ?, ?, ?)`);
  insertPost.run('alice-hidden', alice.user.id, 'alice-hidden', 'hidden', null);
  insertPost.run('alice-deleted', alice.user.id, 'alice-deleted', 'deleted', f.state.now);
  insertPost.run('bob-draft', bob.user.id, 'bob-draft', 'draft', null);
  f.ops.prepare("INSERT INTO post_translations (post_id, locale, title, body) VALUES ('alice-deleted', 'ko', '삭제 제목', '삭제 원문')").run();
  f.ops.prepare(`INSERT INTO comments (id, post_id, author_id, body) VALUES ('alice-comment', 'bob-draft', ?, '내 댓글')`).run(alice.user.id);
  f.ops.prepare(`INSERT INTO comments (id, post_id, author_id, body) VALUES ('bob-comment', 'bob-draft', ?, '다른 사람 댓글')`).run(bob.user.id);
  const posts = (await a.call('/api/me/posts')).body.items;
  assert.equal(posts.length, 2);
  assert.ok(posts.every(post => post.id.startsWith('alice-')));
  assert.equal(posts.find(post => post.status === 'deleted').title, null);
  const comments = (await a.call('/api/me/comments')).body.items;
  assert.equal(comments.length, 1);
  assert.equal(comments[0].post_slug, null);
  assert.equal(comments[0].post_visibility, 'unavailable');
  assert.equal((await a.call(`/api/me/posts?user_id=${bob.user.id}`)).response.status, 400);
  assert.equal((await a.call('/api/me/posts?limit=101')).response.status, 400);
});

test('admin login requires allowed Google subject, provisioned role, code, and member CSRF', async t => {
  const f = await fixture(t);
  const b = browser(f);
  const member = await login(f, b);
  assert.equal((await b.call('/api/admin/session')).response.status, 401);
  assert.equal((await b.call('/api/admin/session', { method: 'POST', body: { code: TEST_CODE }, csrf: member.csrfToken })).response.status, 403);
  provisionAdmin(f, member.user.id, 'consultant');
  assert.equal((await b.call('/api/admin/session', { method: 'POST', body: { code: TEST_CODE } })).response.status, 403);
  const admin = await adminLogin(f, b, member);
  assert.equal(admin.role, 'consultant');
  assert.ok(admin.permissions.includes('consultations:read'));
  assert.ok(!admin.permissions.includes('content:publish'));
  const view = await b.call('/api/admin/session');
  assert.equal(view.response.status, 200);
  const headers = { Cookie: [...b.cookies].map(([key, value]) => `${key}=${value}`).join('; ') };
  await assert.rejects(requireAdmin(new Request(`${f.env.APP_ORIGIN}/api/admin/session`, { headers }), f.env, f.state.now, 'content:publish'), { code: 'ADMIN_FORBIDDEN' });
  f.ops.prepare('UPDATE admin_memberships SET is_active = 0').run();
  assert.equal((await b.call('/api/admin/session')).response.status, 403);
});

test('admin code attempts lock after five failures across member-session rotation and recover after waiting', async t => {
  const f = await fixture(t);
  const b = browser(f);
  let member = await login(f, b);
  provisionAdmin(f, member.user.id);
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await b.call('/api/admin/session', { method: 'POST', body: { code: 'wrong-code-with-at-least-32-characters' }, csrf: member.csrfToken })).response.status, 403);
  }
  member = await login(f, b);
  const blocked = await b.call('/api/admin/session', { method: 'POST', body: { code: TEST_CODE }, csrf: member.csrfToken });
  assert.equal(blocked.response.status, 429);
  assert.equal(blocked.response.headers.get('Retry-After'), '900');
  f.state.now += 901;
  member = await login(f, b);
  await adminLogin(f, b, member);
});

test('admin idle timeout and absolute maximum are both enforced', async t => {
  const f = await fixture(t);
  const b = browser(f);
  let member = await login(f, b);
  provisionAdmin(f, member.user.id);
  await adminLogin(f, b, member);
  f.state.now += ADMIN_IDLE;
  assert.equal((await b.call('/api/admin/session')).response.status, 401);
  member = await login(f, b);
  await adminLogin(f, b, member);
  const created = f.state.now;
  for (let elapsed = 1000; elapsed < ADMIN_TTL; elapsed += 1000) {
    f.state.now = created + elapsed;
    assert.equal((await b.call('/api/admin/session')).response.status, 200);
  }
  f.state.now = created + ADMIN_TTL;
  assert.equal((await b.call('/api/admin/session')).response.status, 401);
});

test('code rotation and removal from the Google allowlist invalidate administrative access', async t => {
  const f = await fixture(t);
  const b = browser(f);
  const member = await login(f, b);
  provisionAdmin(f, member.user.id);
  await adminLogin(f, b, member);
  f.env.ADMIN_GOOGLE_SUBJECTS = 'another-account';
  assert.equal((await b.call('/api/admin/session')).response.status, 403);
  f.env.ADMIN_GOOGLE_SUBJECTS = 'account-a';
  f.env.ADMIN_CODE_SHA256 = await sha256('a-different-random-admin-code-with-32-characters');
  assert.equal((await b.call('/api/admin/session')).response.status, 401);
  assert.equal(f.ops.prepare("SELECT count(*) AS n FROM sessions WHERE kind = 'admin' AND revoked_at IS NULL").get().n, 0);
});

test('logout revokes member and dependent admin sessions and clears browser cookies', async t => {
  const f = await fixture(t);
  const b = browser(f);
  const member = await login(f, b);
  provisionAdmin(f, member.user.id);
  await adminLogin(f, b, member);
  const old = browser(f);
  for (const [name, value] of b.cookies) old.cookies.set(name, value);
  const result = await b.call('/api/auth/logout', { method: 'POST', csrf: member.csrfToken });
  assert.equal(result.response.status, 200);
  assert.equal(b.cookies.size, 0);
  assert.equal((await old.call('/api/me')).response.status, 401);
  assert.equal((await old.call('/api/admin/session')).response.status, 401);
  assert.equal(f.ops.prepare('SELECT count(*) AS n FROM sessions WHERE revoked_at IS NULL').get().n, 0);
});

test('an audit failure rolls back signup, challenge consumption, and session issuance together', async t => {
  const f = await fixture(t);
  const b = browser(f);
  const input = await loginInput(f, b);
  f.ops.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'private-audit-error'); END");
  const result = await b.call('/api/auth/google', { method: 'POST', body: input });
  assert.equal(result.response.status, 503);
  assert.equal(f.ops.prepare('SELECT count(*) AS n FROM users').get().n, 0);
  assert.equal(f.ops.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
  assert.equal(f.ops.prepare('SELECT consumed_at FROM auth_challenges').get().consumed_at, null);
  assert.ok(!JSON.stringify(result.body).includes('private-audit-error'));
});

test('missing configuration fails closed and request bodies are bounded', async t => {
  const f = await fixture(t);
  const b = browser(f);
  const oversized = await b.call('/api/auth/google', { method: 'POST', body: { credential: 'x'.repeat(17_000) } });
  assert.equal(oversized.response.status, 413);
  assert.equal((await b.call('/api/auth/google', { method: 'POST', body: {}, headers: { 'Content-Type': 'text/plain' } })).response.status, 415);
  assert.equal((await b.call('/api/auth/challenge', { method: 'POST', origin: 'https://attacker.invalid' })).response.status, 403);
  f.env.GOOGLE_CLIENT_ID = '';
  assert.equal((await b.call('/api/auth/config')).body.configured, false);
  assert.equal((await b.call('/api/auth/challenge', { method: 'POST' })).response.status, 503);
  assert.equal((await b.call('/api/health')).response.status, 200);
});

test('HTTP cookies are relaxed only for an explicitly enabled loopback origin', async t => {
  const f = await fixture(t);
  f.env.APP_ORIGIN = 'http://127.0.0.1:8787';
  f.env.ALLOW_INSECURE_LOCAL_COOKIES = 'true';
  const b = browser(f);
  const member = await login(f, b);
  assert.ok(b.cookies.has('mli_session'));
  assert.equal((await b.call('/api/me')).body.user.id, member.user.id);
  f.env.APP_ORIGIN = 'https://mli.example';
  assert.equal((await b.call('/api/me')).response.status, 401);
  const secureChallenge = await b.call('/api/auth/challenge', { method: 'POST' });
  assert.ok(secureChallenge.response.headers.getSetCookie()[0].includes('Secure'));
  f.env.APP_ORIGIN = 'http://non-loopback.example';
  assert.equal((await b.call('/api/auth/config')).response.status, 503);
});

test('policy updates require explicit reconsent at login and member sessions expire', async t => {
  const f = await fixture(t);
  const b = browser(f);
  const member = await login(f, b);
  f.env.PRIVACY_VERSION = 'test-privacy-v2';
  const input = await loginInput(f, b);
  assert.equal((await b.call('/api/auth/google', { method: 'POST', body: input })).response.status, 428);
  input.registration.consent.privacyVersion = 'test-privacy-v2';
  const renewed = await b.call('/api/auth/google', { method: 'POST', body: input });
  assert.equal(renewed.response.status, 200);
  assert.equal(renewed.body.user.id, member.user.id);
  assert.equal(f.ops.prepare('SELECT privacy_version FROM users').get().privacy_version, 'test-privacy-v2');
  f.state.now += MEMBER_TTL;
  assert.equal((await b.call('/api/me')).response.status, 401);
});

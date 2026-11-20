import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createWorker } from '../src/worker.js';
import { csrfFor, randomToken, sha256 } from '../src/http.js';

function database(t, kind, through = '9999') {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const directory = new URL(`../migrations/${kind}/`, import.meta.url);
  for (const name of readdirSync(directory).filter(name => name.endsWith('.sql') && name <= through).sort()) {
    db.exec(readFileSync(new URL(name, directory), 'utf8'));
  }
  t.after(() => db.close());
  return db;
}

function d1(db) {
  function prepare(sql, values = []) {
    return {
      bind: (...args) => prepare(sql, args),
      execute() {
        const results = db.prepare(sql).all(...values);
        return { success: true, results, meta: { changes: db.prepare('SELECT changes() AS n').get().n } };
      },
      async first() { return this.execute().results[0] ?? null; },
      async all() { return this.execute(); },
      async run() { return this.execute(); },
    };
  }
  return { prepare, async batch(statements) {
    db.exec('BEGIN');
    try {
      const results = statements.map(statement => statement.execute());
      db.exec('COMMIT');
      return results;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
}

function insert(db, table, values) {
  const columns = Object.keys(values);
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...Object.values(values));
}

async function fixture(t) {
  const ops = database(t, 'ops');
  const content = database(t, 'content');
  const state = { now: 1_800_000_000, calls: [], reply: null, failure: false };
  const env = {
    OPS_DB: d1(ops), CONTENT_DB: d1(content), APP_ORIGIN: 'https://mli.example',
    GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com', TERMS_VERSION: 'terms-v1', PRIVACY_VERSION: 'privacy-v1',
    INTAKE_PRIVACY_VERSION: 'intake-v1', MARKETING_CONSENT_VERSION: 'marketing-v1',
    TURNSTILE_SITE_KEY: 'fixture-site-key', TURNSTILE_SECRET_KEY: 'fixture-private-secret',
    ADMIN_GOOGLE_SUBJECTS: '', ADMIN_CODE_SHA256: await sha256('test-only-admin-code-with-at-least-32-characters'),
  };
  const worker = createWorker({ clock: () => state.now, turnstileFetch: async (url, options) => {
    const input = JSON.parse(options.body);
    state.calls.push({ url, input, options });
    if (state.failure) throw new Error('private-network-detail');
    if (state.response) return state.response();
    return Response.json(state.reply ?? {
      success: true, hostname: 'mli.example', action: input.response.split(':')[0],
      challenge_ts: new Date(state.now * 1000).toISOString(),
    });
  } });
  const f = { ops, content, state, env, worker };
  f.call = async (path, { method = 'GET', body, key, csrf, cookies, ip = '203.0.113.7', origin = env.APP_ORIGIN, headers = {} } = {}) => {
    const h = new Headers(headers);
    if (origin !== null) h.set('Origin', origin);
    if (ip !== null) h.set('CF-Connecting-IP', ip);
    if (key !== undefined) h.set('Idempotency-Key', key);
    if (csrf) h.set('X-CSRF-Token', csrf);
    if (cookies) h.set('Cookie', cookies);
    if (body !== undefined && !h.has('Content-Type')) h.set('Content-Type', 'application/json');
    const response = await worker.fetch(new Request(`${env.APP_ORIGIN}${path}`, {
      method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    return { response, body: await response.json() };
  };
  f.admin = async (role = 'consultant', allowed = true) => {
    const id = crypto.randomUUID();
    const subject = `subject-${id}`;
    const memberId = crypto.randomUUID();
    const memberToken = randomToken();
    const adminToken = randomToken();
    insert(ops, 'users', { id, nickname: '운영자', terms_version: 'v1', privacy_version: 'v1', consented_at: state.now });
    insert(ops, 'auth_identities', { id: crypto.randomUUID(), user_id: id, provider: 'google', subject, email: 'admin@example.invalid' });
    insert(ops, 'admin_memberships', { user_id: id, role });
    insert(ops, 'sessions', { id: memberId, user_id: id, kind: 'member', token_hash: await sha256(memberToken),
      created_at: state.now, last_seen_at: state.now, expires_at: state.now + 86400 });
    insert(ops, 'sessions', { id: crypto.randomUUID(), user_id: id, kind: 'admin', admin_user_id: id,
      token_hash: await sha256(adminToken), member_session_id: memberId, admin_code_fingerprint: await sha256(env.ADMIN_CODE_SHA256),
      created_at: state.now, last_seen_at: state.now, expires_at: state.now + 28800 });
    if (allowed) env.ADMIN_GOOGLE_SUBJECTS += `${env.ADMIN_GOOGLE_SUBJECTS ? ',' : ''}${subject}`;
    return { id, cookies: `__Host-mli_session=${memberToken}; __Host-mli_admin=${adminToken}`,
      memberCookie: `__Host-mli_session=${memberToken}`, csrf: await csrfFor(adminToken), memberCsrf: await csrfFor(memberToken) };
  };
  return f;
}

function input(kind = 'consultations', overrides = {}) {
  return { name: ' 신청자 ', email: 'member@EXAMPLE.invalid', preferredLanguage: 'ko',
    consent: { privacy: true, privacyVersion: 'intake-v1' },
    ...(kind === 'consultations' ? { consultationType: 'individual', topic: '상담 원문 테스트' } : { inquiryType: 'general', message: '문의 원문 테스트' }),
    turnstileToken: `${kind === 'consultations' ? 'consultation' : 'inquiry'}:${crypto.randomUUID()}`, ...overrides };
}

async function submit(f, kind = 'consultations', body = input(kind), options = {}) {
  return f.call(`/api/${kind}`, { method: 'POST', key: crypto.randomUUID(), body, ...options });
}

const count = (f, table) => f.ops.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

test('intake config and anonymous submission do not depend on Google login configuration', async t => {
  const f = await fixture(t);
  delete f.env.GOOGLE_CLIENT_ID;
  delete f.env.TERMS_VERSION;
  delete f.env.PRIVACY_VERSION;
  const config = await f.call('/api/intake/config');
  assert.equal(config.response.status, 200);
  assert.equal(config.body.privacyVersion, 'intake-v1');
  assert.ok(!JSON.stringify(config.body).includes('fixture-private-secret'));
  assert.equal((await submit(f)).response.status, 201);
  f.env.TURNSTILE_SECRET_KEY = '';
  assert.equal((await f.call('/api/intake/config')).response.status, 503);
  assert.equal((await submit(f)).response.status, 503);
  assert.equal(count(f, 'consultations'), 1);
});

test('anonymous consultation persists server consent evidence, a receipt and a metadata-only audit atomically', async t => {
  const f = await fixture(t);
  const body = input('consultations', { phone: '010-1234-5678', preferredTime1: f.state.now + 3600 });
  const result = await submit(f, 'consultations', body);
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  assert.match(result.body.receiptNumber, /^C-\d{8}-[0-9A-F]{16}$/);
  assert.deepEqual(Object.keys(result.body).sort(), ['receiptNumber', 'receivedAt', 'replayed']);
  assert.equal(result.response.headers.get('cache-control'), 'no-store');
  const row = f.ops.prepare('SELECT * FROM consultations').get();
  assert.equal(row.name, '신청자');
  assert.equal(row.email, 'member@example.invalid');
  assert.equal(row.status, 'new');
  assert.equal(row.confirmed_time, null);
  assert.equal(row.privacy_consent_version, 'intake-v1');
  assert.equal(row.privacy_consented_at, f.state.now);
  assert.equal(row.marketing_opt_in, 0);
  assert.equal(row.marketing_consented_at, null);
  assert.equal(row.retention_until, null);
  assert.equal(count(f, 'intake_token_redemptions'), 1);
  assert.equal(count(f, 'audit_events'), 1);
  const audit = JSON.stringify(f.ops.prepare('SELECT * FROM audit_events').all());
  for (const privateValue of [body.email, row.email, body.topic, body.phone, body.turnstileToken, body.name.trim()]) {
    assert.ok(!audit.includes(privateValue));
  }
  assert.equal(f.content.prepare('SELECT count(*) AS n FROM published_posts').get().n, 0);
  assert.equal(f.state.calls[0].url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.equal(f.state.calls[0].input.remoteip, '203.0.113.7');
  assert.equal(f.state.calls[0].options.redirect, 'manual');
});

test('Contact accepts its five categories and keeps marketing and consultation fields out', async t => {
  const f = await fixture(t);
  for (const inquiryType of ['general', 'press', 'research', 'partnership', 'site_issue']) {
    const result = await submit(f, 'inquiries', input('inquiries', { inquiryType }));
    assert.equal(result.response.status, 201);
    assert.match(result.body.receiptNumber, /^I-/);
  }
  assert.equal(count(f, 'inquiries'), 5);
  assert.equal((await submit(f, 'inquiries', input('inquiries', { consultationType: 'individual' }))).response.status, 400);
});

test('submission rejects missing consent, untrusted fields, bad input, missing idempotency and cross-site requests', async t => {
  const cases = [
    { body: { status: 'confirmed' }, status: 400 }, { body: { assignedAdminId: crypto.randomUUID() }, status: 400 },
    { body: { name: '' }, status: 400 }, { body: { name: 'x'.repeat(101) }, status: 400 },
    { body: { email: 'not-an-email' }, status: 400 }, { body: { topic: 'x'.repeat(5001) }, status: 400 },
    { body: { topic: 'a\u0000b' }, status: 400 }, { body: { phone: '<script>' }, status: 400 },
    { body: { preferredTimezone: 'invalid/timezone' }, status: 400 }, { body: { preferredLanguage: 'unknown' }, status: 400 },
    { body: { preferredMode: 'anywhere' }, status: 400 }, { body: { preferredTime1: 'tomorrow' }, status: 400 },
    { body: { preferredTime1: 1 }, status: 400 }, { body: { consent: { privacy: false, privacyVersion: 'intake-v1' } }, status: 428 },
    { body: { consent: { privacy: true, privacyVersion: 'old' } }, status: 428 },
    { body: { consent: { privacy: true, privacyVersion: 'intake-v1', consentedAt: 1 } }, status: 400 },
    { key: 'short', status: 400 }, { key: '', status: 400 }, { origin: null, status: 403 },
    { origin: 'https://attacker.invalid', status: 403 }, { headers: { 'Sec-Fetch-Site': 'cross-site' }, status: 403 },
    { headers: { 'Content-Type': 'text/plain' }, status: 415 },
  ];
  for (const example of cases) {
    const f = await fixture(t);
    const { status, body, ...options } = example;
    const result = await submit(f, 'consultations', input('consultations', body), options);
    assert.equal(result.response.status, status, JSON.stringify(example));
    assert.equal(count(f, 'consultations'), 0);
    assert.equal(f.state.calls.length, 0);
  }
});

test('marketing requires separate explicit current consent and retention is configured by the server', async t => {
  const f = await fixture(t);
  f.env.INTAKE_RETENTION_DAYS = '90';
  const consent = { privacy: true, privacyVersion: 'intake-v1', marketing: true };
  assert.equal((await submit(f, 'consultations', input('consultations', { consent }))).response.status, 428);
  consent.marketingVersion = 'marketing-v1';
  assert.equal((await submit(f, 'consultations', input('consultations', { consent }))).response.status, 201);
  const row = f.ops.prepare('SELECT * FROM consultations').get();
  assert.equal(row.marketing_consented_at, f.state.now);
  assert.equal(row.marketing_consent_version, 'marketing-v1');
  assert.equal(row.retention_until, f.state.now + 90 * 86400);
  f.env.INTAKE_RETENTION_DAYS = '-1';
  assert.equal((await submit(f)).response.status, 503);
});

test('a normalized retry returns the original receipt without revalidating its spent token or past preferred time', async t => {
  const f = await fixture(t);
  const key = crypto.randomUUID();
  const body = input('consultations', { preferredTime1: f.state.now + 60 });
  const first = await submit(f, 'consultations', body, { key });
  f.state.now += 7200;
  f.env.INTAKE_PRIVACY_VERSION = 'intake-v2';
  const retry = await submit(f, 'consultations', { ...body, name: body.name.trim(), turnstileToken: 'expired' }, { key });
  assert.equal(first.response.status, 201);
  assert.equal(retry.response.status, 200);
  assert.equal(retry.body.receiptNumber, first.body.receiptNumber);
  assert.equal(retry.body.receivedAt, first.body.receivedAt);
  assert.equal(retry.body.replayed, true);
  assert.equal(f.state.calls.length, 1);
  assert.equal((await submit(f, 'consultations', body)).response.status, 428);
  const conflict = await submit(f, 'consultations', { ...body, topic: 'different' }, { key });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error, 'IDEMPOTENCY_CONFLICT');
  assert.equal(count(f, 'audit_events'), 1);
});

test('concurrent identical submissions produce one receipt and one audit event', async t => {
  const f = await fixture(t);
  const body = input();
  const key = crypto.randomUUID();
  const results = await Promise.all([submit(f, 'consultations', body, { key }), submit(f, 'consultations', body, { key })]);
  assert.deepEqual(results.map(result => result.response.status).sort(), [200, 201]);
  assert.equal(results[0].body.receiptNumber, results[1].body.receiptNumber);
  for (const table of ['consultations', 'audit_events', 'intake_token_redemptions']) assert.equal(count(f, table), 1);
});

test('Turnstile tokens cannot create two receipts even if concurrent Siteverify calls both succeed', async t => {
  const f = await fixture(t);
  const body = input();
  const results = await Promise.all([submit(f, 'consultations', body), submit(f, 'consultations', body)]);
  assert.deepEqual(results.map(result => result.response.status).sort(), [201, 403]);
  assert.equal(results.find(result => result.response.status === 403).body.error, 'TURNSTILE_REUSED');
  for (const table of ['consultations', 'audit_events', 'intake_token_redemptions']) assert.equal(count(f, table), 1);
});

test('audit failure rolls back receipt and token redemption so a retry can complete', async t => {
  const f = await fixture(t);
  const body = input();
  const key = crypto.randomUUID();
  f.ops.exec("CREATE TRIGGER fail_intake_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'private-audit-detail'); END");
  const result = await submit(f, 'consultations', body, { key });
  assert.equal(result.response.status, 503);
  assert.ok(!JSON.stringify(result.body).includes('private-audit-detail'));
  for (const table of ['consultations', 'audit_events', 'intake_token_redemptions']) assert.equal(count(f, table), 0);
  f.ops.exec('DROP TRIGGER fail_intake_audit');
  assert.equal((await submit(f, 'consultations', body, { key })).response.status, 201);
});

test('Turnstile requires valid server success, hostname, action and a recent timestamp', async t => {
  const cases = [
    [{ success: false, 'error-codes': ['timeout-or-duplicate'] }, 403],
    [{ success: true, hostname: 'attacker.invalid' }, 403], [{ success: true, action: 'inquiry' }, 403],
    [{ success: true, challenge_ts: '2000-01-01T00:00:00Z' }, 403],
    [{ success: true, challenge_ts: '2099-01-01T00:00:00Z' }, 403],
    [{ success: true, challenge_ts: null }, 403], [{ success: 'true' }, 503],
    [{ success: false, 'error-codes': ['invalid-input-secret'] }, 503],
  ];
  for (const [reply, expected] of cases) {
    const f = await fixture(t);
    f.state.reply = { hostname: 'mli.example', action: 'consultation', challenge_ts: new Date(f.state.now * 1000).toISOString(), ...reply };
    assert.equal((await submit(f)).response.status, expected, JSON.stringify(reply));
    assert.equal(count(f, 'consultations'), 0);
  }
  const f = await fixture(t);
  f.state.failure = true;
  const result = await submit(f);
  assert.equal(result.response.status, 503);
  assert.equal(result.body.error, 'TURNSTILE_UNAVAILABLE');
  assert.equal((await submit(f, 'consultations', input('consultations', { turnstileToken: '' }))).response.status, 400);
  assert.equal((await submit(f, 'consultations', input('consultations', { turnstileToken: 'x'.repeat(2049) }))).response.status, 400);
  for (const response of [
    () => new Response('', { status: 302, headers: { Location: 'https://attacker.invalid' } }),
    () => new Response('unavailable', { status: 503 }),
    () => new Response('invalid-json', { status: 200 }),
  ]) {
    const unavailable = await fixture(t);
    unavailable.state.response = response;
    assert.equal((await submit(unavailable)).response.status, 503);
    assert.equal(count(unavailable, 'consultations'), 0);
  }
});

test('IP limits include receipt retries and hashed email limits span client IPs', async t => {
  const f = await fixture(t);
  const body = input();
  const key = crypto.randomUUID();
  for (let index = 0; index < 20; index++) assert.ok([200, 201].includes((await submit(f, 'consultations', body, { key })).response.status));
  const limited = await submit(f, 'consultations', body, { key });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.response.headers.get('retry-after'), '600');
  f.state.now += 601;
  assert.equal((await submit(f, 'consultations', body, { key })).response.status, 200);
  const other = await fixture(t);
  for (let index = 0; index < 5; index++) assert.equal((await submit(other, 'consultations', input(), { ip: `203.0.113.${index}` })).response.status, 201);
  const emailLimited = await submit(other, 'inquiries', input('inquiries'), { ip: '203.0.113.250' });
  assert.equal(emailLimited.response.status, 429);
  assert.equal(emailLimited.response.headers.get('retry-after'), '3600');
  const buckets = JSON.stringify(other.ops.prepare('SELECT * FROM auth_rate_limits').all());
  assert.ok(!buckets.includes('203.0.113.') && !buckets.includes('member@'));
});

test('intake bounds request bytes while allowing a complete Korean form larger than the auth limit', async t => {
  const f = await fixture(t);
  const body = input('consultations', { topic: '가'.repeat(5000), name: '나'.repeat(100), organization: '다'.repeat(200),
    jobTitle: '라'.repeat(100), turnstileToken: `consultation:${'x'.repeat(2000)}` });
  assert.ok(new TextEncoder().encode(JSON.stringify(body)).length > 16384);
  assert.equal((await submit(f, 'consultations', body)).response.status, 201);
  assert.equal((await submit(f, 'consultations', { padding: '가'.repeat(22000) })).response.status, 413);
});

test('admin intake requires a current authorized admin session and the admin CSRF token for writes', async t => {
  const f = await fixture(t);
  await submit(f);
  const id = f.ops.prepare('SELECT id FROM consultations').get().id;
  const detail = `/api/admin/consultations/${id}`;
  for (const path of ['/api/admin/consultations', '/api/admin/inquiries', detail, '/api/admin/intake-assignees', '/api/admin/audit-events']) {
    assert.equal((await f.call(path)).response.status, 401);
  }
  for (const role of ['editor', 'moderator']) {
    const admin = await f.admin(role);
    assert.equal((await f.call('/api/admin/consultations', admin)).response.status, 403);
    assert.equal((await f.call(detail, { ...admin, method: 'PATCH', body: { version: 1, status: 'reviewing' } })).response.status, 403);
  }
  const admin = await f.admin();
  assert.equal((await f.call(detail, { cookies: admin.memberCookie })).response.status, 401);
  const patch = { ...admin, method: 'PATCH', body: { version: 1, status: 'reviewing' } };
  assert.equal((await f.call(detail, { ...patch, csrf: undefined })).response.status, 403);
  assert.equal((await f.call(detail, { ...patch, csrf: admin.memberCsrf })).response.status, 403);
  assert.equal((await f.call(detail, { ...patch, origin: 'https://attacker.invalid' })).response.status, 403);
  assert.equal((await f.call(detail, patch)).response.status, 200);
  f.ops.prepare('UPDATE admin_memberships SET is_active = 0 WHERE user_id = ?').run(admin.id);
  assert.equal((await f.call(detail, admin)).response.status, 403);
});

test('admin lists use validated filters and pagination and detail reads exclude private deduplication data', async t => {
  const f = await fixture(t);
  await submit(f);
  await submit(f, 'consultations', input('consultations', { consultationType: 'organization' }));
  const admin = await f.admin();
  const list = await f.call('/api/admin/consultations?type=individual&status=new&assignedAdminId=unassigned&limit=1', admin);
  assert.equal(list.response.status, 200);
  assert.equal(list.body.total, 1);
  assert.equal(list.body.items.length, 1);
  assert.ok(!JSON.stringify(list.body).includes('member@example.invalid'));
  const id = list.body.items[0].id;
  const detail = await f.call(`/api/admin/consultations/${id}`, admin);
  assert.equal(detail.body.item.topic, '상담 원문 테스트');
  assert.equal(detail.body.item.email, 'member@example.invalid');
  for (const field of ['request_hash', 'idempotency_key', 'requestHash', 'idempotencyKey', 'turnstileToken']) assert.ok(!(field in detail.body.item));
  assert.equal(f.ops.prepare("SELECT count(*) AS n FROM audit_events WHERE action = 'intake.viewed'").get().n, 1);
  assert.equal((await f.call(`/api/admin/consultations/${crypto.randomUUID()}`, admin)).response.status, 404);
  for (const suffix of ['?limit=101', '?offset=-1', '?status=published', '?type=unknown', '?limit=1&limit=2', '?search=private', '?assignedAdminId=bad']) {
    assert.equal((await f.call(`/api/admin/consultations${suffix}`, admin)).response.status, 400, suffix);
  }
  assert.equal((await f.call('/api/consultations')).response.status, 405);
  assert.equal((await f.call('/api/consultations/receipt-number')).response.status, 404);
});

test('consultation transitions require a confirmed schedule and preserve versions, assignment and notes', async t => {
  const f = await fixture(t);
  await submit(f);
  const admin = await f.admin();
  const path = `/api/admin/consultations/${f.ops.prepare('SELECT id FROM consultations').get().id}`;
  const patch = body => f.call(path, { ...admin, method: 'PATCH', body });
  assert.equal((await patch({ version: 1, status: 'confirmed', confirmedTime: f.state.now + 3600 })).response.status, 409);
  let result = await patch({ version: 1, status: 'reviewing', assignedAdminId: admin.id, internalNote: '내부 처리 메모', followUpAt: f.state.now + 60 });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.item.version, 2);
  assert.equal(result.body.item.assignedAdminId, admin.id);
  result = await patch({ version: 2, status: 'proposed' });
  assert.equal(result.body.item.confirmedTime, null);
  assert.equal((await patch({ version: 3, status: 'confirmed' })).response.status, 400);
  result = await patch({ version: 3, status: 'confirmed', confirmedTime: f.state.now + 3600 });
  assert.equal(result.body.item.version, 4);
  result = await patch({ version: 4, status: 'proposed', assignedAdminId: null, internalNote: '', followUpAt: null });
  assert.equal(result.body.item.confirmedTime, null);
  assert.equal(result.body.item.internalNote, '');
  assert.equal(result.body.item.assignedAdminId, null);
  assert.equal((await patch({ version: 5, status: 'cancelled' })).response.status, 200);
  assert.equal((await patch({ version: 6, status: 'reviewing' })).response.status, 409);
});

test('assignees must be active allowed Google accounts with an intake role', async t => {
  const f = await fixture(t);
  await submit(f);
  const admin = await f.admin();
  const inactive = await f.admin();
  const editor = await f.admin('editor');
  const notAllowed = await f.admin('consultant', false);
  f.ops.prepare('UPDATE admin_memberships SET is_active = 0 WHERE user_id = ?').run(inactive.id);
  const path = `/api/admin/consultations/${f.ops.prepare('SELECT id FROM consultations').get().id}`;
  for (const assignedAdminId of [inactive.id, editor.id, notAllowed.id, crypto.randomUUID(), [admin.id]]) {
    assert.equal((await f.call(path, { ...admin, method: 'PATCH', body: { version: 1, assignedAdminId } })).response.status, 400);
  }
  const assignees = await f.call('/api/admin/intake-assignees', admin);
  assert.deepEqual(assignees.body.items.map(item => item.id), [admin.id]);
  assert.ok(!JSON.stringify(assignees.body).includes('subject-'));
});

test('optimistic concurrent edits produce one update and no phantom audit, and audit failure rolls the update back', async t => {
  const f = await fixture(t);
  await submit(f);
  const admin = await f.admin();
  const path = `/api/admin/consultations/${f.ops.prepare('SELECT id FROM consultations').get().id}`;
  const results = await Promise.all(['메모 A', '메모 B'].map(internalNote => f.call(path, {
    ...admin, method: 'PATCH', body: { version: 1, status: 'reviewing', internalNote },
  })));
  assert.deepEqual(results.map(result => result.response.status).sort(), [200, 409]);
  assert.equal(f.ops.prepare("SELECT count(*) AS n FROM audit_events WHERE action = 'intake.updated'").get().n, 1);
  const before = f.ops.prepare('SELECT * FROM consultations').get();
  assert.equal(before.version, 2);
  f.ops.exec("CREATE TRIGGER fail_update_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'private-audit-detail'); END");
  assert.equal((await f.call(path, { ...admin, method: 'PATCH', body: { version: 2, internalNote: 'must roll back' } })).response.status, 503);
  assert.deepEqual(f.ops.prepare('SELECT * FROM consultations').get(), before);
});

test('inquiry workflows and audit visibility follow their own statuses and role permissions', async t => {
  const f = await fixture(t);
  await submit(f, 'inquiries');
  const admin = await f.admin('admin');
  const consultant = await f.admin();
  const row = f.ops.prepare('SELECT * FROM inquiries').get();
  const path = `/api/admin/inquiries/${row.id}`;
  const patch = body => f.call(path, { ...consultant, method: 'PATCH', body });
  assert.equal((await patch({ version: 1, status: 'proposed' })).response.status, 400);
  assert.equal((await patch({ version: 1, confirmedTime: f.state.now })).response.status, 400);
  assert.equal((await patch({ version: 1, status: 'reviewing', internalNote: '비공개 메모' })).response.status, 200);
  assert.equal((await patch({ version: 2, status: 'needs_info' })).response.status, 200);
  assert.equal((await patch({ version: 3, status: 'completed' })).response.status, 200);
  assert.equal((await patch({ version: 4, status: 'reviewing' })).response.status, 409);
  assert.equal((await f.call('/api/admin/audit-events', consultant)).response.status, 403);
  const events = await f.call(`/api/admin/audit-events?targetType=inquiry&targetId=${row.id}`, admin);
  assert.equal(events.response.status, 200);
  assert.equal(events.body.items.length, 4);
  const audit = JSON.stringify(events.body);
  assert.ok(!audit.includes('비공개 메모') && !audit.includes(row.email) && !audit.includes(row.message));
  assert.equal(events.body.items.filter(item => item.nextState === 'completed').length, 1);
});

test('stage 3 migration preserves an existing stage 2 intake and health requires the new protection table', async t => {
  const f = await fixture(t);
  const old = database(t, 'ops', '0005_auth_session_indexes.sql');
  insert(old, 'consultations', { id: crypto.randomUUID(), receipt_number: 'C-EXISTING', idempotency_key: crypto.randomUUID(),
    request_hash: 'a'.repeat(64), name: '기존 신청자', email: 'old@example.invalid', consultation_type: 'other',
    topic: '기존 접수', privacy_consent_version: 'old-policy', privacy_consented_at: 1 });
  f.env.OPS_DB = d1(old);
  assert.equal((await f.call('/api/health')).response.status, 503);
  old.exec(readFileSync(new URL('../migrations/ops/0006_intake_protection.sql', import.meta.url), 'utf8'));
  assert.equal(old.prepare('SELECT name FROM consultations').get().name, '기존 신청자');
  assert.deepEqual((await f.call('/api/health')).body, { status: 'ok', stage: 3 });
  assert.deepEqual(old.prepare('PRAGMA foreign_key_check').all(), []);
});

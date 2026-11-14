import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { sha256 } from '../src/http.js';

// Isolated simulator storage and a test-only outbound service. The built default
// Worker still verifies RS256 signatures at its fixed Google JWKS URL.
const keys = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(keys.publicKey), kid: 'runtime-test', alg: 'RS256' };
const code = 'runtime-test-only-admin-code-with-at-least-32-characters';
const origin = 'https://runtime-test.example';
const clientId = 'runtime-test.apps.googleusercontent.com';
const simulator = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  scriptPath: fileURLToPath(new URL('../.build/worker.js', import.meta.url)),
  compatibilityDate: '2026-11-08',
  bindings: {
    APP_ORIGIN: origin, GOOGLE_CLIENT_ID: clientId, TERMS_VERSION: 'runtime-terms',
    PRIVACY_VERSION: 'runtime-privacy', ADMIN_GOOGLE_SUBJECTS: 'runtime-account',
    ADMIN_CODE_SHA256: await sha256(code),
  },
  d1Databases: { OPS_DB: 'isolated-auth-ops', CONTENT_DB: 'isolated-auth-content' },
  outboundService: async request => {
    assert.equal(request.url, 'https://www.googleapis.com/oauth2/v3/certs');
    return Response.json({ keys: [jwk] }, { headers: { 'Cache-Control': 'public, max-age=3600' } });
  },
}));

try {
  const ops = await simulator.getD1Database('OPS_DB');
  const content = await simulator.getD1Database('CONTENT_DB');
  for (const [kind, db] of [['ops', ops], ['content', content]]) {
    const directory = new URL(`../migrations/${kind}/`, import.meta.url);
    for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
      const sql = readFileSync(new URL(name, directory), 'utf8').replace(/--[^\r\n]*/g, '');
      const statements = sql.split(';').map(value => value.trim()).filter(Boolean);
      await db.batch(statements.map(statement => db.prepare(statement)));
    }
  }
  const cookies = new Map();
  async function call(path, method = 'GET', body, csrf) {
    const headers = new Headers({ Origin: origin });
    headers.set('Cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '));
    if (csrf) headers.set('X-CSRF-Token', csrf);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await simulator.dispatchFetch(`${origin}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [name, value] = cookie.split(';')[0].split('=');
      if (cookie.includes('Max-Age=0;') || cookie.endsWith('Max-Age=0')) cookies.delete(name);
      else cookies.set(name, value);
    }
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await call('/api/health')).status, 200);
  const challenge = await call('/api/auth/challenge', 'POST');
  assert.equal(challenge.status, 200);
  const now = Math.floor(Date.now() / 1000);
  const credential = await new SignJWT({
    iss: 'https://accounts.google.com', aud: clientId, sub: 'runtime-account',
    email: 'runtime@example.invalid', email_verified: true, nonce: challenge.body.nonce,
    iat: now, exp: now + 600,
  }).setProtectedHeader({ alg: 'RS256', kid: 'runtime-test' }).sign(keys.privateKey);
  const member = await call('/api/auth/google', 'POST', {
    credential, csrfToken: challenge.body.csrfToken,
    registration: { nickname: '런타임 테스트', preferredLanguage: 'ko',
      consent: { terms: true, privacy: true, termsVersion: 'runtime-terms', privacyVersion: 'runtime-privacy' } },
  });
  assert.equal(member.status, 200, JSON.stringify(member.body));
  assert.equal((await call('/api/me')).body.user.id, member.body.user.id);
  assert.equal((await call('/api/me', 'PATCH', { nickname: '변경된 닉네임' }, member.body.csrfToken)).status, 200);
  assert.equal((await call('/api/me/posts')).status, 200);
  await ops.prepare("INSERT INTO admin_memberships (user_id, role) VALUES (?, 'consultant')").bind(member.body.user.id).run();
  assert.equal((await call('/api/admin/session', 'POST', { code }, member.body.csrfToken)).status, 200);
  assert.equal((await call('/api/admin/session')).body.role, 'consultant');
  assert.equal((await call('/api/auth/logout', 'POST', undefined, member.body.csrfToken)).status, 200);
  assert.equal((await call('/api/me')).status, 401);
  assert.equal((await call('/api/admin/session')).status, 401);
  console.log('PASS: built Worker + actual local D1: signed login, profile, ownership query, admin role, logout');
} finally {
  await simulator.dispose();
}

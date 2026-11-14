import { verifyGoogle } from './google.js';
import {
  ADMIN_IDLE, ADMIN_TTL, CHALLENGE_TTL, MEMBER_TTL, LANGUAGES, HttpError,
  checkCsrf, config, csrfFor, equalStrings, json, publicUser, randomToken,
  readCookie, setCookie, sha256,
} from './http.js';

export const ROLE_PERMISSIONS = {
  admin: ['content:write', 'content:publish', 'moderation:write', 'consultations:read', 'consultations:write', 'audit:read'],
  editor: ['content:write', 'content:publish'],
  moderator: ['moderation:write'],
  consultant: ['consultations:read', 'consultations:write'],
};

export async function reserveAttempts(db, keys, limit, seconds, now) {
  const hashes = await Promise.all(keys.map(key => sha256(key)));
  const results = await db.batch(hashes.map(hash => db.prepare(`
    INSERT INTO auth_rate_limits (key_hash, attempts, reset_at) VALUES (?, 1, ?)
    ON CONFLICT(key_hash) DO UPDATE SET
      attempts = CASE WHEN reset_at <= ? THEN 1 ELSE attempts + 1 END,
      reset_at = CASE WHEN reset_at <= ? THEN ?
        WHEN attempts + 1 >= ? THEN MAX(reset_at, ?) ELSE reset_at END
    WHERE reset_at <= ? OR attempts < ?
    RETURNING attempts, reset_at
  `).bind(hash, now + seconds, now, now, now + seconds, limit, now + seconds, now, limit)));
  if (results.some(result => result.results.length === 0)) {
    throw new HttpError(429, 'TOO_MANY_ATTEMPTS', { 'Retry-After': String(seconds) });
  }
  return hashes;
}

function ipKey(request, scope) {
  // Cloudflare sets CF-Connecting-IP. Local requests share one local bucket.
  return `${scope}:ip:${request.headers.get('CF-Connecting-IP') ?? 'local'}`;
}

export async function createChallenge(request, env, now) {
  config(env);
  await reserveAttempts(env.OPS_DB, [ipKey(request, 'challenge')], 30, 60, now);
  const token = randomToken();
  const nonce = randomToken();
  const csrfToken = randomToken();
  const [tokenHash, nonceHash, csrfHash] = await Promise.all([token, nonce, csrfToken].map(sha256));
  await env.OPS_DB.batch([
    env.OPS_DB.prepare('DELETE FROM auth_challenges WHERE token_hash IN (SELECT token_hash FROM auth_challenges WHERE expires_at <= ? LIMIT 100)').bind(now),
    env.OPS_DB.prepare('DELETE FROM auth_rate_limits WHERE key_hash IN (SELECT key_hash FROM auth_rate_limits WHERE reset_at <= ? LIMIT 100)').bind(now),
    env.OPS_DB.prepare('INSERT INTO auth_challenges (token_hash, nonce_hash, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(tokenHash, nonceHash, csrfHash, now, now + CHALLENGE_TTL),
  ]);
  const response = json({ nonce, csrfToken, expiresIn: CHALLENGE_TTL });
  setCookie(response, request, env, 'login', token, CHALLENGE_TTL);
  return response;
}

export function validateProfile(body, partial = false) {
  const values = {};
  if (!partial || body.nickname !== undefined) {
    if (typeof body.nickname !== 'string' || !body.nickname.trim()
      || Array.from(body.nickname.trim()).length > 40 || /[\u0000-\u001f\u007f]/.test(body.nickname)) {
      throw new HttpError(400, 'NICKNAME_INVALID');
    }
    values.nickname = body.nickname.trim();
  }
  if (!partial || body.preferredLanguage !== undefined) {
    const language = body.preferredLanguage ?? 'ko';
    if (!LANGUAGES.includes(language)) throw new HttpError(400, 'LANGUAGE_INVALID');
    values.language = language;
  }
  return values;
}

function consentAccepted(registration, settings) {
  return registration?.consent?.terms === true && registration?.consent?.privacy === true
    && registration.consent.termsVersion === settings.termsVersion
    && registration.consent.privacyVersion === settings.privacyVersion;
}

export async function googleLogin(request, env, body, now, keys) {
  const settings = config(env);
  await reserveAttempts(env.OPS_DB, [ipKey(request, 'google-login')], 30, 60, now);
  const challengeToken = readCookie(request, env, 'login');
  if (!challengeToken || typeof body.csrfToken !== 'string') throw new HttpError(403, 'LOGIN_CHALLENGE_INVALID');
  const challengeHash = await sha256(challengeToken);
  const challenge = await env.OPS_DB.prepare('SELECT * FROM auth_challenges WHERE token_hash = ?').bind(challengeHash).first();
  if (!challenge || challenge.expires_at <= now || challenge.consumed_at !== null
    || !equalStrings(challenge.csrf_hash, await sha256(body.csrfToken))) {
    throw new HttpError(403, 'LOGIN_CHALLENGE_INVALID');
  }
  const identity = await verifyGoogle(body.credential, settings.clientId, now, keys);
  if (!equalStrings(challenge.nonce_hash, await sha256(identity.nonce))) {
    throw new HttpError(401, 'GOOGLE_NONCE_INVALID');
  }
  const existing = await env.OPS_DB.prepare(`
    SELECT u.* FROM users u JOIN auth_identities i ON i.user_id = u.id
    WHERE i.provider = 'google' AND i.subject = ?
  `).bind(identity.sub).first();
  if (existing && existing.status !== 'active') throw new HttpError(403, 'ACCOUNT_INACTIVE');
  const accepted = consentAccepted(body.registration, settings);
  if ((!existing || existing.terms_version !== settings.termsVersion || existing.privacy_version !== settings.privacyVersion)
    && !accepted) throw new HttpError(428, 'CONSENT_REQUIRED');
  const profile = existing ? { nickname: existing.nickname, language: existing.preferred_language }
    : validateProfile(body.registration ?? {});
  const token = randomToken();
  const tokenHash = await sha256(token);
  const sessionId = crypto.randomUUID();
  const candidateUserId = crypto.randomUUID();
  const oldTokens = [readCookie(request, env, 'session'), readCookie(request, env, 'admin')];
  const oldHashes = await Promise.all(oldTokens.map(value => value ? sha256(value) : null));
  // The consumed challenge carries this request's random session ID. Every write
  // is guarded by it inside one atomic D1 batch, so a replay cannot create users
  // or sessions. Subject lookup also serializes simultaneous first registrations.
  const gate = 'EXISTS (SELECT 1 FROM auth_challenges WHERE token_hash = ? AND session_id = ?)';
  const results = await env.OPS_DB.batch([
    env.OPS_DB.prepare(`UPDATE auth_challenges SET consumed_at = ?, session_id = ?
      WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`).bind(now, sessionId, challengeHash, now),
    env.OPS_DB.prepare(`INSERT INTO users (id, nickname, preferred_language, terms_version, privacy_version, consented_at, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${gate}
      AND NOT EXISTS (SELECT 1 FROM auth_identities WHERE provider = 'google' AND subject = ?)`)
      .bind(candidateUserId, profile.nickname, profile.language, settings.termsVersion, settings.privacyVersion,
        now, now, now, challengeHash, sessionId, identity.sub),
    env.OPS_DB.prepare(`INSERT INTO auth_identities (id, user_id, provider, subject, email, created_at)
      SELECT ?, ?, 'google', ?, ?, ? WHERE ${gate} AND EXISTS (SELECT 1 FROM users WHERE id = ?)
      AND NOT EXISTS (SELECT 1 FROM auth_identities WHERE provider = 'google' AND subject = ?)`)
      .bind(crypto.randomUUID(), candidateUserId, identity.sub, identity.email, now,
        challengeHash, sessionId, candidateUserId, identity.sub),
    env.OPS_DB.prepare(`UPDATE auth_identities SET email = ? WHERE provider = 'google' AND subject = ? AND ${gate}`)
      .bind(identity.email, identity.sub, challengeHash, sessionId),
    env.OPS_DB.prepare(`UPDATE users SET terms_version = ?, privacy_version = ?, consented_at = ?, updated_at = ?
      WHERE id = (SELECT user_id FROM auth_identities WHERE provider = 'google' AND subject = ?)
      AND status = 'active' AND ? = 1 AND ${gate}`)
      .bind(settings.termsVersion, settings.privacyVersion, now, now, identity.sub, accepted ? 1 : 0, challengeHash, sessionId),
    env.OPS_DB.prepare(`INSERT INTO sessions (id, user_id, token_hash, kind, created_at, last_seen_at, expires_at)
      SELECT ?, u.id, ?, 'member', ?, ?, ? FROM users u JOIN auth_identities i ON i.user_id = u.id
      WHERE i.provider = 'google' AND i.subject = ? AND u.status = 'active'
      AND u.terms_version = ? AND u.privacy_version = ? AND ${gate}`)
      .bind(sessionId, tokenHash, now, now, now + MEMBER_TTL, identity.sub,
        settings.termsVersion, settings.privacyVersion, challengeHash, sessionId),
    env.OPS_DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL
      AND (token_hash IN (?, ?) OR member_session_id IN (SELECT id FROM sessions WHERE token_hash IN (?, ?)))
      AND EXISTS (SELECT 1 FROM sessions WHERE id = ?)`)
      .bind(now, ...oldHashes, ...oldHashes, sessionId),
    env.OPS_DB.prepare(`INSERT INTO audit_events (id, actor_user_id, actor_kind, action, target_type, target_id, request_id, created_at)
      SELECT ?, user_id, 'user', 'member.login', 'session', id, ?, ? FROM sessions WHERE id = ?`)
      .bind(crypto.randomUUID(), crypto.randomUUID(), now, sessionId),
  ]);
  if (results[0].meta.changes !== 1) throw new HttpError(409, 'LOGIN_CHALLENGE_USED');
  if (results[5].meta.changes !== 1) throw new HttpError(403, 'ACCOUNT_INACTIVE');
  const row = await env.OPS_DB.prepare(`SELECT u.id AS user_id, u.nickname, u.preferred_language
    FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.id = ?`).bind(sessionId).first();
  const response = json({ user: publicUser(row), csrfToken: await csrfFor(token), expiresAt: now + MEMBER_TTL });
  setCookie(response, request, env, 'session', token, MEMBER_TTL);
  setCookie(response, request, env, 'login', '', 0);
  setCookie(response, request, env, 'admin', '', 0);
  return response;
}

export async function requireMember(request, env, now) {
  return requireSession(request, env, now, 'member');
}

async function requireSession(request, env, now, kind) {
  const token = readCookie(request, env, kind === 'member' ? 'session' : 'admin');
  if (!token) throw new HttpError(401, 'SESSION_REQUIRED');
  const row = await env.OPS_DB.prepare(`
    SELECT s.*, u.nickname, u.preferred_language, u.status AS user_status, i.subject AS google_subject
    FROM sessions s JOIN users u ON u.id = s.user_id
    JOIN auth_identities i ON i.user_id = u.id AND i.provider = 'google'
    WHERE s.token_hash = ? AND s.kind = ?
  `).bind(await sha256(token), kind).first();
  if (!row || row.revoked_at !== null || row.expires_at <= now
    || (kind === 'admin' && row.last_seen_at <= now - ADMIN_IDLE)) {
    throw new HttpError(401, 'SESSION_EXPIRED');
  }
  if (row.user_status !== 'active') throw new HttpError(403, 'ACCOUNT_INACTIVE');
  const updated = await env.OPS_DB.prepare(`UPDATE sessions SET last_seen_at = MAX(last_seen_at, ?)
    WHERE id = ? AND revoked_at IS NULL AND expires_at > ?
    AND (? = 'member' OR last_seen_at > ?)
    AND EXISTS (SELECT 1 FROM users WHERE id = sessions.user_id AND status = 'active')
    RETURNING id`).bind(now, row.id, now, kind, now - ADMIN_IDLE).first();
  if (!updated) throw new HttpError(401, 'SESSION_EXPIRED');
  return { token, session: row };
}

function adminSettings(env) {
  if (!/^[0-9a-f]{64}$/.test(env.ADMIN_CODE_SHA256 ?? '')) throw new HttpError(503, 'ADMIN_NOT_CONFIGURED');
  const allowed = (env.ADMIN_GOOGLE_SUBJECTS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (!allowed.length) throw new HttpError(503, 'ADMIN_NOT_CONFIGURED');
  return { codeHash: env.ADMIN_CODE_SHA256, allowed };
}

export async function requireAdmin(request, env, now, permission) {
  const member = await requireMember(request, env, now);
  const settings = adminSettings(env);
  const fingerprint = await sha256(settings.codeHash);
  await env.OPS_DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE kind = 'admin' AND revoked_at IS NULL
    AND (admin_code_fingerprint IS NULL OR admin_code_fingerprint <> ?)`)
    .bind(now, fingerprint).run();
  const admin = await requireSession(request, env, now, 'admin');
  const membership = await env.OPS_DB.prepare('SELECT role FROM admin_memberships WHERE user_id = ? AND is_active = 1')
    .bind(admin.session.user_id).first();
  const permissions = membership ? ROLE_PERMISSIONS[membership.role] : null;
  if (admin.session.member_session_id !== member.session.id
    || admin.session.user_id !== member.session.user_id
    || !settings.allowed.includes(admin.session.google_subject)
    || !equalStrings(admin.session.admin_code_fingerprint, fingerprint)
    || !permissions || (permission && !permissions.includes(permission))) {
    throw new HttpError(403, 'ADMIN_FORBIDDEN');
  }
  return { ...admin, role: membership.role, permissions };
}

export async function createAdminSession(request, env, body, member, now) {
  const settings = adminSettings(env);
  await checkCsrf(request, member.token);
  if (member.session.created_at < now - CHALLENGE_TTL) throw new HttpError(401, 'GOOGLE_REAUTH_REQUIRED');
  const buckets = await reserveAttempts(env.OPS_DB, [
    ipKey(request, 'admin'), `admin:user:${member.session.user_id}`, `admin:session:${member.session.id}`,
  ], 5, 15 * 60, now);
  const membership = await env.OPS_DB.prepare('SELECT role FROM admin_memberships WHERE user_id = ? AND is_active = 1')
    .bind(member.session.user_id).first();
  const validCode = typeof body.code === 'string' && /^[\x21-\x7e]{32,128}$/.test(body.code)
    && equalStrings(await sha256(body.code), settings.codeHash);
  if (!validCode || !settings.allowed.includes(member.session.google_subject) || !membership) {
    await env.OPS_DB.prepare(`INSERT INTO audit_events
      (id, actor_user_id, actor_kind, action, target_type, target_id, request_id, created_at)
      VALUES (?, ?, 'user', 'admin.login_failed', 'session', ?, ?, ?)`)
      .bind(crypto.randomUUID(), member.session.user_id, member.session.id, crypto.randomUUID(), now).run();
    throw new HttpError(403, 'ADMIN_AUTH_FAILED');
  }
  const token = randomToken();
  const sessionId = crypto.randomUUID();
  const fingerprint = await sha256(settings.codeHash);
  const oldToken = readCookie(request, env, 'admin');
  const oldHash = oldToken ? await sha256(oldToken) : null;
  const result = await env.OPS_DB.batch([
    env.OPS_DB.prepare(`INSERT INTO sessions
      (id, user_id, token_hash, kind, admin_user_id, created_at, last_seen_at, expires_at, admin_code_fingerprint, member_session_id)
      SELECT ?, s.user_id, ?, 'admin', s.user_id, ?, ?, ?, ?, s.id FROM sessions s
      JOIN users u ON u.id = s.user_id JOIN admin_memberships a ON a.user_id = s.user_id
      WHERE s.id = ? AND s.kind = 'member' AND s.revoked_at IS NULL AND s.expires_at > ?
      AND u.status = 'active' AND a.is_active = 1`)
      .bind(sessionId, await sha256(token), now, now, Math.min(now + ADMIN_TTL, member.session.expires_at),
        fingerprint, member.session.id, now),
    env.OPS_DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE kind = 'admin' AND revoked_at IS NULL
      AND (token_hash = ? OR admin_code_fingerprint IS NULL OR admin_code_fingerprint <> ?)
      AND EXISTS (SELECT 1 FROM sessions WHERE id = ?)`)
      .bind(now, oldHash, fingerprint, sessionId),
    env.OPS_DB.prepare(`INSERT INTO audit_events (id, actor_user_id, actor_kind, action, target_type, target_id, request_id, created_at)
      SELECT ?, user_id, 'user', 'admin.login', 'session', id, ?, ? FROM sessions WHERE id = ?`)
      .bind(crypto.randomUUID(), crypto.randomUUID(), now, sessionId),
    env.OPS_DB.prepare(`DELETE FROM auth_rate_limits WHERE key_hash IN (?, ?, ?)
      AND EXISTS (SELECT 1 FROM sessions WHERE id = ?)`).bind(...buckets, sessionId),
  ]);
  if (result[0].meta.changes !== 1) throw new HttpError(403, 'ADMIN_FORBIDDEN');
  const current = await env.OPS_DB.prepare(`SELECT a.role FROM admin_memberships a
    JOIN sessions s ON s.user_id = a.user_id WHERE s.id = ? AND a.is_active = 1`).bind(sessionId).first();
  if (!current) throw new HttpError(403, 'ADMIN_FORBIDDEN');
  const response = json({ role: current.role, permissions: ROLE_PERMISSIONS[current.role],
    csrfToken: await csrfFor(token), expiresAt: Math.min(now + ADMIN_TTL, member.session.expires_at) });
  setCookie(response, request, env, 'admin', token, Math.min(ADMIN_TTL, member.session.expires_at - now));
  return response;
}

export async function logout(request, env, now) {
  const memberToken = readCookie(request, env, 'session');
  const adminToken = readCookie(request, env, 'admin');
  if (memberToken || adminToken) await checkCsrf(request, memberToken ?? adminToken);
  const hashes = await Promise.all([memberToken, adminToken].map(token => token ? sha256(token) : null));
  const loginToken = readCookie(request, env, 'login');
  await env.OPS_DB.batch([
    env.OPS_DB.prepare(`INSERT INTO audit_events (id, actor_user_id, actor_kind, action, target_type, target_id, request_id, created_at)
      SELECT lower(hex(randomblob(16))), user_id, 'user', 'session.logout', 'session', id, ?, ?
      FROM sessions WHERE token_hash IN (?, ?) AND revoked_at IS NULL`)
      .bind(crypto.randomUUID(), now, ...hashes),
    env.OPS_DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL
      AND (token_hash IN (?, ?) OR member_session_id IN (SELECT id FROM sessions WHERE token_hash IN (?, ?)))`)
      .bind(now, ...hashes, ...hashes),
    env.OPS_DB.prepare('DELETE FROM auth_challenges WHERE token_hash = ?').bind(loginToken ? await sha256(loginToken) : null),
  ]);
  const response = json({ status: 'logged_out' });
  for (const name of ['session', 'admin', 'login']) setCookie(response, request, env, name, '', 0);
  return response;
}

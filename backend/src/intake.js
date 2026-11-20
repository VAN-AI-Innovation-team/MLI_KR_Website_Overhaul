import { reserveAttempts } from './auth.js';
import { LANGUAGES, HttpError, json, originConfig, sha256 } from './http.js';
import { verifyTurnstile } from './turnstile.js';

export const INTAKE = {
  consultations: {
    target: 'consultation', typeColumn: 'consultation_type', prefix: 'C',
    types: ['individual', 'organization', 'other'],
    transitions: {
      new: ['reviewing', 'cancelled'],
      reviewing: ['needs_info', 'proposed', 'cancelled'],
      needs_info: ['reviewing', 'cancelled'],
      proposed: ['reviewing', 'needs_info', 'confirmed', 'cancelled'],
      confirmed: ['proposed', 'completed', 'cancelled'],
      completed: [], cancelled: [],
    },
  },
  inquiries: {
    target: 'inquiry', typeColumn: 'inquiry_type', prefix: 'I',
    types: ['general', 'press', 'research', 'partnership', 'site_issue'],
    transitions: {
      new: ['reviewing', 'cancelled'],
      reviewing: ['needs_info', 'completed', 'cancelled'],
      needs_info: ['reviewing', 'completed', 'cancelled'],
      completed: [], cancelled: [],
    },
  },
};

export function onlyFields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !allowed.includes(key))) throw new HttpError(400, 'INVALID_FIELDS');
}

export function text(value, max, optional = false, multiline = false) {
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== 'string') throw new HttpError(400, 'INVALID_INPUT');
  const normalized = value.normalize('NFC').replaceAll('\r\n', '\n').trim();
  const control = multiline ? /[\u0000-\u0008\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (normalized.length > max || control.test(normalized) || (!optional && !normalized)) {
    throw new HttpError(400, 'INVALID_INPUT');
  }
  return normalized || null;
}

export function unixTime(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 253_402_300_799) throw new HttpError(400, 'INVALID_TIME');
  return value;
}

export function intakeSettings(env) {
  originConfig(env);
  const privacyVersion = env.INTAKE_PRIVACY_VERSION?.trim();
  const marketingVersion = env.MARKETING_CONSENT_VERSION?.trim() || null;
  if (!privacyVersion || privacyVersion.length > 128 || (marketingVersion && marketingVersion.length > 128)
    || !env.TURNSTILE_SITE_KEY?.trim() || !env.TURNSTILE_SECRET_KEY?.trim()) {
    throw new HttpError(503, 'INTAKE_NOT_CONFIGURED');
  }
  let retentionDays = null;
  if (env.INTAKE_RETENTION_DAYS?.trim()) {
    if (!/^[1-9]\d{0,4}$/.test(env.INTAKE_RETENTION_DAYS) || Number(env.INTAKE_RETENTION_DAYS) > 36500) {
      throw new HttpError(503, 'INTAKE_NOT_CONFIGURED');
    }
    retentionDays = Number(env.INTAKE_RETENTION_DAYS);
  }
  return { privacyVersion, marketingVersion, retentionDays, siteKey: env.TURNSTILE_SITE_KEY.trim() };
}

export function intakeConfig(env) {
  try {
    const settings = intakeSettings(env);
    return json({ configured: true, siteKey: settings.siteKey, privacyVersion: settings.privacyVersion,
      marketingVersion: settings.marketingVersion, languages: LANGUAGES,
      actions: { consultations: 'consultation', inquiries: 'inquiry' } });
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return json({ configured: false, error: 'INTAKE_NOT_CONFIGURED' }, 503);
  }
}

function normalize(body, kind) {
  const consultation = kind === 'consultations';
  onlyFields(body, ['name', 'email', 'preferredLanguage', 'consent', 'turnstileToken',
    ...(consultation ? ['phone', 'consultationType', 'topic', 'organization', 'jobTitle',
      'preferredTime1', 'preferredTime2', 'preferredTimezone', 'preferredMode'] : ['inquiryType', 'message'])]);
  const email = text(body.email, 254);
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(email)
    || email.includes('..')) throw new HttpError(400, 'INVALID_EMAIL');
  const separator = email.lastIndexOf('@');
  const preferredLanguage = body.preferredLanguage === undefined ? 'ko' : body.preferredLanguage;
  if (!LANGUAGES.includes(preferredLanguage)) throw new HttpError(400, 'INVALID_LANGUAGE');
  const type = consultation ? body.consultationType : body.inquiryType;
  if (!INTAKE[kind].types.includes(type)) throw new HttpError(400, 'INVALID_TYPE');
  onlyFields(body.consent, consultation ? ['privacy', 'privacyVersion', 'marketing', 'marketingVersion'] : ['privacy', 'privacyVersion']);
  if (body.consent.privacy !== true || typeof body.consent.privacyVersion !== 'string' || !body.consent.privacyVersion.trim()) {
    throw new HttpError(428, 'INTAKE_CONSENT_REQUIRED');
  }
  const record = {
    name: text(body.name, 100), email: `${email.slice(0, separator)}@${email.slice(separator + 1).toLowerCase()}`,
    [INTAKE[kind].typeColumn]: type, preferred_language: preferredLanguage,
    privacy_consent_version: text(body.consent.privacyVersion, 128),
  };
  if (consultation) {
    const marketing = body.consent.marketing === undefined ? false : body.consent.marketing;
    if (typeof marketing !== 'boolean') throw new HttpError(400, 'INVALID_CONSENT');
    if (marketing && (typeof body.consent.marketingVersion !== 'string' || !body.consent.marketingVersion.trim())) {
      throw new HttpError(428, 'MARKETING_CONSENT_REQUIRED');
    }
    if (!marketing && body.consent.marketingVersion !== undefined) throw new HttpError(400, 'INVALID_CONSENT');
    const phone = text(body.phone, 40, true);
    if (phone && !/^\+?[0-9 ()-]{5,40}$/.test(phone)) throw new HttpError(400, 'INVALID_PHONE');
    const timezone = body.preferredTimezone === undefined ? 'Asia/Seoul' : text(body.preferredTimezone, 100);
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new HttpError(400, 'INVALID_TIMEZONE'); }
    const mode = body.preferredMode ?? null;
    if (mode !== null && !['online', 'offline'].includes(mode)) throw new HttpError(400, 'INVALID_MODE');
    Object.assign(record, {
      phone, topic: text(body.topic, 5000, false, true),
      organization: text(body.organization, 200, true), job_title: text(body.jobTitle, 100, true),
      preferred_time_1: unixTime(body.preferredTime1), preferred_time_2: unixTime(body.preferredTime2),
      preferred_timezone: timezone, preferred_mode: mode,
      marketing_opt_in: marketing ? 1 : 0, marketing_consent_version: marketing ? text(body.consent.marketingVersion, 128) : null,
    });
  } else record.message = text(body.message, 5000, false, true);
  return record;
}

function receipt(row, requestHash, replayed) {
  if (row.request_hash !== requestHash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT');
  return json({ receiptNumber: row.receipt_number, receivedAt: row.created_at, replayed }, replayed ? 200 : 201);
}

export async function submitIntake(request, env, body, kind, now, turnstileFetch) {
  const settings = intakeSettings(env);
  await reserveAttempts(env.OPS_DB, [`intake:ip:${request.headers.get('CF-Connecting-IP') ?? 'local'}`], 20, 600, now);
  const key = request.headers.get('Idempotency-Key');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key ?? '')) throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED');
  const record = normalize(body, kind);
  const requestHash = await sha256(JSON.stringify(record));
  const lookup = () => env.OPS_DB.prepare(`SELECT receipt_number, request_hash, created_at FROM ${kind} WHERE idempotency_key = ?`).bind(key).first();
  const existing = await lookup();
  // A lost success response can be retried with the same key and content even
  // after its one-use Turnstile token or preferred appointment has expired.
  if (existing) return receipt(existing, requestHash, true);
  if (record.privacy_consent_version !== settings.privacyVersion) throw new HttpError(428, 'INTAKE_CONSENT_REQUIRED');
  if (record.marketing_opt_in && record.marketing_consent_version !== settings.marketingVersion) {
    throw new HttpError(428, 'MARKETING_CONSENT_REQUIRED');
  }
  if (kind === 'consultations' && [record.preferred_time_1, record.preferred_time_2].some(value => value !== null && value <= now)) {
    throw new HttpError(400, 'PREFERRED_TIME_IN_PAST');
  }
  await reserveAttempts(env.OPS_DB, [`intake:email:${record.email.toLowerCase()}`], 5, 3600, now);
  await verifyTurnstile(request, env, body.turnstileToken, INTAKE[kind].target, now, turnstileFetch);
  const tokenHash = await sha256(body.turnstileToken);
  const id = crypto.randomUUID();
  const receiptNumber = `${INTAKE[kind].prefix}-${new Date(now * 1000).toISOString().slice(0, 10).replaceAll('-', '')}-${crypto.randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
  const stored = {
    id, receipt_number: receiptNumber, idempotency_key: key, request_hash: requestHash, ...record,
    privacy_consented_at: now,
    ...(kind === 'consultations' ? { marketing_consented_at: record.marketing_opt_in ? now : null } : {}),
    retention_until: settings.retentionDays === null ? null : now + settings.retentionDays * 86400,
    created_at: now, updated_at: now,
  };
  const columns = Object.keys(stored);
  try {
    await env.OPS_DB.batch([
      env.OPS_DB.prepare('DELETE FROM intake_token_redemptions WHERE token_hash IN (SELECT token_hash FROM intake_token_redemptions WHERE expires_at <= ? LIMIT 100)').bind(now),
      env.OPS_DB.prepare('DELETE FROM auth_rate_limits WHERE key_hash IN (SELECT key_hash FROM auth_rate_limits WHERE reset_at <= ? LIMIT 100)').bind(now),
      env.OPS_DB.prepare(`INSERT INTO ${kind} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).bind(...Object.values(stored)),
      env.OPS_DB.prepare('INSERT INTO intake_token_redemptions (token_hash, consumed_at, expires_at) VALUES (?, ?, ?)').bind(tokenHash, now, now + 600),
      env.OPS_DB.prepare(`INSERT INTO audit_events
        (id, actor_kind, action, target_type, target_id, next_state, request_id, created_at)
        VALUES (?, 'system', 'intake.submitted', ?, ?, 'new', ?, ?)`)
        .bind(crypto.randomUUID(), INTAKE[kind].target, id, crypto.randomUUID(), now),
    ]);
  } catch (error) {
    const winner = await lookup();
    if (winner) return receipt(winner, requestHash, true);
    const redeemed = await env.OPS_DB.prepare('SELECT token_hash FROM intake_token_redemptions WHERE token_hash = ?').bind(tokenHash).first();
    if (redeemed) throw new HttpError(403, 'TURNSTILE_REUSED');
    throw error;
  }
  return receipt({ receipt_number: receiptNumber, request_hash: requestHash, created_at: now }, requestHash, false);
}

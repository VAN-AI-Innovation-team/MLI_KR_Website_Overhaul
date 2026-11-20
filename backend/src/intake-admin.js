import { HttpError, json } from './http.js';
import { INTAKE, onlyFields, text, unixTime } from './intake.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMON_FIELDS = {
  id: 'id', receipt_number: 'receiptNumber', name: 'name', email: 'email',
  preferred_language: 'preferredLanguage', privacy_consent_version: 'privacyConsentVersion',
  privacy_consented_at: 'privacyConsentedAt', status: 'status', assigned_admin_id: 'assignedAdminId',
  internal_note: 'internalNote', follow_up_at: 'followUpAt', version: 'version',
  retention_until: 'retentionUntil', created_at: 'createdAt', updated_at: 'updatedAt',
};
const CONSULTATION_FIELDS = {
  consultation_type: 'consultationType', phone: 'phone', topic: 'topic', organization: 'organization',
  job_title: 'jobTitle', preferred_time_1: 'preferredTime1', preferred_time_2: 'preferredTime2',
  preferred_timezone: 'preferredTimezone', preferred_mode: 'preferredMode', confirmed_time: 'confirmedTime',
  marketing_opt_in: 'marketingOptIn', marketing_consent_version: 'marketingConsentVersion', marketing_consented_at: 'marketingConsentedAt',
};

function fields(kind) {
  return { ...COMMON_FIELDS, ...(kind === 'consultations' ? CONSULTATION_FIELDS : { inquiry_type: 'inquiryType', message: 'message' }) };
}

function selected(mapping) {
  return Object.entries(mapping).map(([column, alias]) => `${column} AS "${alias}"`).join(', ');
}

function identifier(id) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new HttpError(400, 'INVALID_ID');
}

function query(request, allowed) {
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1)) {
    throw new HttpError(400, 'INVALID_QUERY');
  }
  return params;
}

function page(params) {
  const number = (key, fallback, min, max) => {
    const value = params.get(key);
    if (value === null) return fallback;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
      throw new HttpError(400, 'INVALID_PAGINATION');
    }
    return Number(value);
  };
  return { limit: number('limit', 20, 1, 100), offset: number('offset', 0, 0, 10000) };
}

export async function listIntake(request, env, kind) {
  const spec = INTAKE[kind];
  const params = query(request, ['limit', 'offset', 'status', 'type', 'assignedAdminId']);
  const { limit, offset } = page(params);
  const clauses = [];
  const values = [];
  if (params.has('status')) {
    if (!Object.hasOwn(spec.transitions, params.get('status'))) throw new HttpError(400, 'INVALID_STATUS');
    clauses.push('status = ?'); values.push(params.get('status'));
  }
  if (params.has('type')) {
    if (!spec.types.includes(params.get('type'))) throw new HttpError(400, 'INVALID_TYPE');
    clauses.push(`${spec.typeColumn} = ?`); values.push(params.get('type'));
  }
  if (params.has('assignedAdminId')) {
    const assignee = params.get('assignedAdminId');
    if (assignee === 'unassigned') clauses.push('assigned_admin_id IS NULL');
    else { identifier(assignee); clauses.push('assigned_admin_id = ?'); values.push(assignee); }
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const summary = { id: 'id', receipt_number: 'receiptNumber', name: 'name', [spec.typeColumn]: 'type',
    status: 'status', assigned_admin_id: 'assignedAdminId', follow_up_at: 'followUpAt',
    version: 'version', created_at: 'createdAt', updated_at: 'updatedAt' };
  const [items, count] = await env.OPS_DB.batch([
    env.OPS_DB.prepare(`SELECT ${selected(summary)} FROM ${kind}${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).bind(...values, limit, offset),
    env.OPS_DB.prepare(`SELECT count(*) AS total FROM ${kind}${where}`).bind(...values),
  ]);
  return json({ items: items.results, total: count.results[0].total, limit, offset });
}

export async function readIntake(request, env, kind, id, admin, now) {
  identifier(id);
  query(request, []);
  const [result] = await env.OPS_DB.batch([
    env.OPS_DB.prepare(`SELECT ${selected(fields(kind))} FROM ${kind} WHERE id = ?`).bind(id),
    env.OPS_DB.prepare(`INSERT INTO audit_events
      (id, actor_user_id, actor_kind, action, target_type, target_id, request_id, created_at)
      SELECT ?, ?, 'user', 'intake.viewed', ?, id, ?, ? FROM ${kind} WHERE id = ?`)
      .bind(crypto.randomUUID(), admin.session.user_id, INTAKE[kind].target, crypto.randomUUID(), now, id),
  ]);
  if (!result.results.length) throw new HttpError(404, 'INTAKE_NOT_FOUND');
  return json({ item: result.results[0] });
}

function allowedSubjects(env) {
  return (env.ADMIN_GOOGLE_SUBJECTS ?? '').split(',').map(value => value.trim()).filter(Boolean);
}

export async function intakeAssignees(request, env) {
  query(request, []);
  const allowed = allowedSubjects(env);
  const result = await env.OPS_DB.prepare(`SELECT m.user_id AS id, u.nickname, m.role, i.subject
    FROM admin_memberships m JOIN users u ON u.id = m.user_id
    JOIN auth_identities i ON i.user_id = u.id AND i.provider = 'google'
    WHERE m.is_active = 1 AND u.status = 'active' AND m.role IN ('admin', 'consultant')
    ORDER BY u.nickname, m.user_id`).all();
  return json({ items: result.results.filter(row => allowed.includes(row.subject)).map(({ subject, ...row }) => row) });
}

export async function updateIntake(request, env, body, kind, id, admin, now) {
  identifier(id);
  query(request, []);
  onlyFields(body, ['version', 'status', 'assignedAdminId', 'internalNote', 'followUpAt',
    ...(kind === 'consultations' ? ['confirmedTime'] : [])]);
  if (!Number.isSafeInteger(body.version) || body.version < 1 || body.version >= Number.MAX_SAFE_INTEGER
    || Object.keys(body).length < 2) throw new HttpError(400, 'INVALID_UPDATE');
  const current = await env.OPS_DB.prepare(`SELECT * FROM ${kind} WHERE id = ?`).bind(id).first();
  if (!current) throw new HttpError(404, 'INTAKE_NOT_FOUND');
  if (current.version !== body.version) throw new HttpError(409, 'VERSION_CONFLICT');
  const nextStatus = body.status === undefined ? current.status : body.status;
  const transitions = INTAKE[kind].transitions;
  if (!Object.hasOwn(transitions, nextStatus)) throw new HttpError(400, 'INVALID_STATUS');
  if (nextStatus !== current.status && !transitions[current.status].includes(nextStatus)) {
    throw new HttpError(409, 'INVALID_STATUS_TRANSITION');
  }
  const changes = { status: nextStatus };
  const assigneeChanged = Object.hasOwn(body, 'assignedAdminId');
  const allowed = allowedSubjects(env);
  if (assigneeChanged) {
    if (body.assignedAdminId !== null) {
      identifier(body.assignedAdminId);
      const target = await env.OPS_DB.prepare(`SELECT i.subject FROM admin_memberships m
        JOIN users u ON u.id = m.user_id JOIN auth_identities i ON i.user_id = u.id AND i.provider = 'google'
        WHERE m.user_id = ? AND m.is_active = 1 AND u.status = 'active' AND m.role IN ('admin', 'consultant')`)
        .bind(body.assignedAdminId).first();
      if (!target || !allowed.includes(target.subject)) throw new HttpError(400, 'INVALID_ASSIGNEE');
    }
    changes.assigned_admin_id = body.assignedAdminId;
  }
  if (Object.hasOwn(body, 'internalNote')) {
    if (typeof body.internalNote !== 'string') throw new HttpError(400, 'INVALID_INPUT');
    changes.internal_note = text(body.internalNote, 10000, true, true) ?? '';
  }
  if (Object.hasOwn(body, 'followUpAt')) {
    changes.follow_up_at = unixTime(body.followUpAt);
    if (changes.follow_up_at !== null && changes.follow_up_at <= now) throw new HttpError(400, 'FOLLOW_UP_IN_PAST');
  }
  if (kind === 'consultations') {
    let confirmed = current.confirmed_time;
    if (Object.hasOwn(body, 'confirmedTime')) {
      if (nextStatus !== 'confirmed') throw new HttpError(400, 'INVALID_CONFIRMED_TIME');
      confirmed = unixTime(body.confirmedTime);
    }
    if (!['confirmed', 'completed'].includes(nextStatus)) confirmed = null;
    if (nextStatus === 'confirmed' && (confirmed === null
      || ((current.status !== 'confirmed' || Object.hasOwn(body, 'confirmedTime')) && confirmed <= now))) {
      throw new HttpError(400, 'CONFIRMED_TIME_REQUIRED');
    }
    changes.confirmed_time = confirmed;
  }
  changes.updated_at = now;
  // Recheck assignment eligibility in the conditional write, so deactivation
  // between the read and update cannot assign a request to an inactive account.
  const guard = assigneeChanged && body.assignedAdminId !== null
    ? ` AND EXISTS (SELECT 1 FROM admin_memberships m JOIN users u ON u.id = m.user_id
        JOIN auth_identities i ON i.user_id = u.id AND i.provider = 'google'
        WHERE m.user_id = ? AND m.is_active = 1 AND u.status = 'active' AND m.role IN ('admin', 'consultant')
        AND i.subject IN (${allowed.map(() => '?').join(', ')}))` : '';
  const [result] = await env.OPS_DB.batch([
    env.OPS_DB.prepare(`UPDATE ${kind} SET ${Object.keys(changes).map(column => `${column} = ?`).join(', ')}, version = version + 1
      WHERE id = ? AND version = ?${guard} RETURNING ${selected(fields(kind))}`)
      .bind(...Object.values(changes), id, body.version, ...(guard ? [body.assignedAdminId, ...allowed] : [])),
    // changes() refers to the immediately preceding conditional UPDATE in this
    // atomic batch. A losing writer must never create a phantom audit event.
    env.OPS_DB.prepare(`INSERT INTO audit_events
      (id, actor_user_id, actor_kind, action, target_type, target_id, previous_state, next_state, request_id, created_at)
      SELECT ?, ?, 'user', 'intake.updated', ?, ?, ?, ?, ?, ? WHERE changes() = 1`)
      .bind(crypto.randomUUID(), admin.session.user_id, INTAKE[kind].target, id, current.status, nextStatus, crypto.randomUUID(), now),
  ]);
  if (!result.results.length) throw new HttpError(409, 'VERSION_CONFLICT');
  return json({ item: result.results[0] });
}

export async function intakeAudit(request, env) {
  const params = query(request, ['targetType', 'targetId', 'limit', 'offset']);
  const { limit, offset } = page(params);
  const clauses = ["target_type IN ('consultation', 'inquiry')"];
  const values = [];
  if (params.has('targetType')) {
    if (!['consultation', 'inquiry'].includes(params.get('targetType'))) throw new HttpError(400, 'INVALID_TYPE');
    clauses.push('target_type = ?'); values.push(params.get('targetType'));
  }
  if (params.has('targetId')) { identifier(params.get('targetId')); clauses.push('target_id = ?'); values.push(params.get('targetId')); }
  const result = await env.OPS_DB.prepare(`SELECT id, actor_user_id AS "actorUserId", actor_kind AS "actorKind", action,
    target_type AS "targetType", target_id AS "targetId", previous_state AS "previousState", next_state AS "nextState",
    request_id AS "requestId", created_at AS "createdAt"
    FROM audit_events WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .bind(...values, limit, offset).all();
  return json({ items: result.results, limit, offset });
}

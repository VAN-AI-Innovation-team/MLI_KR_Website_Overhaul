import { HttpError, json, publicUser } from './http.js';
import { validateProfile } from './auth.js';

export async function updateProfile(env, body, member, now) {
  const fields = Object.keys(body);
  if (!fields.length || fields.some(key => !['nickname', 'preferredLanguage'].includes(key))) {
    throw new HttpError(400, 'PROFILE_FIELDS_INVALID');
  }
  const values = validateProfile(body, true);
  const activeSession = `EXISTS (SELECT 1 FROM sessions WHERE id = ? AND user_id = users.id
    AND kind = 'member' AND revoked_at IS NULL AND expires_at > ?)`;
  const result = await env.OPS_DB.batch([
    env.OPS_DB.prepare(`UPDATE users SET nickname = COALESCE(?, nickname),
      preferred_language = COALESCE(?, preferred_language), updated_at = ?
      WHERE id = ? AND status = 'active' AND ${activeSession}
      RETURNING id AS user_id, nickname, preferred_language`)
      .bind(values.nickname ?? null, values.language ?? null, now, member.session.user_id, member.session.id, now),
    env.OPS_DB.prepare(`INSERT INTO audit_events (id, actor_user_id, actor_kind, action, target_type, target_id, request_id, created_at)
      SELECT ?, id, 'user', 'profile.update', 'user', id, ?, ? FROM users
      WHERE id = ? AND status = 'active' AND ${activeSession}`)
      .bind(crypto.randomUUID(), crypto.randomUUID(), now, member.session.user_id, member.session.id, now),
  ]);
  if (!result[0].results.length) throw new HttpError(401, 'SESSION_EXPIRED');
  return json({ user: publicUser(result[0].results[0]) });
}

export async function ownActivity(request, env, member, kind) {
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some(key => !['limit', 'offset'].includes(key))) throw new HttpError(400, 'PAGINATION_INVALID');
  const limit = Number(query.get('limit') ?? 20);
  const offset = Number(query.get('offset') ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 10_000) {
    throw new HttpError(400, 'PAGINATION_INVALID');
  }
  const sql = kind === 'posts' ? `
    SELECT p.id, p.board_type, p.status, p.created_at, p.updated_at,
      CASE WHEN p.status <> 'deleted' THEN p.slug END AS slug,
      CASE WHEN p.status <> 'deleted' THEN COALESCE(t.title, original.title) END AS title,
      CASE WHEN p.status <> 'deleted' THEN p.public_moderation_reason END AS moderation_reason
    FROM posts p
    LEFT JOIN post_translations t ON t.post_id = p.id AND t.locale = ?
    LEFT JOIN post_translations original ON original.post_id = p.id AND original.locale = p.original_language
    WHERE p.author_id = ? ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?
  ` : `
    SELECT c.id, c.post_id, c.status, c.created_at, c.updated_at,
      CASE WHEN c.status <> 'deleted' THEN c.body END AS body,
      CASE WHEN p.status = 'published' THEN p.slug END AS post_slug,
      CASE WHEN p.status = 'published' THEN 'public' ELSE 'unavailable' END AS post_visibility,
      CASE WHEN c.status <> 'deleted' THEN c.public_moderation_reason END AS moderation_reason
    FROM comments c JOIN posts p ON p.id = c.post_id
    WHERE c.author_id = ? ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?
  `;
  const parameters = kind === 'posts'
    ? [member.session.preferred_language, member.session.user_id, limit, offset]
    : [member.session.user_id, limit, offset];
  const result = await env.OPS_DB.prepare(sql).bind(...parameters).all();
  return json({ items: result.results, nextOffset: result.results.length === limit ? offset + limit : null });
}

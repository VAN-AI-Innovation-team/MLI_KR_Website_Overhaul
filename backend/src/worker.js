import { createAdminSession, createChallenge, googleLogin, logout, requireAdmin, requireMember } from './auth.js';
import { LANGUAGES, HttpError, checkCsrf, checkOrigin, config, csrfFor, json, publicUser, readJson } from './http.js';
import { ownActivity, updateProfile } from './profile.js';
import { intakeConfig, submitIntake } from './intake.js';
import { intakeAssignees, intakeAudit, listIntake, readIntake, updateIntake } from './intake-admin.js';

const METHODS = {
  '/api/health': ['GET'],
  '/api/auth/config': ['GET'],
  '/api/auth/challenge': ['POST'],
  '/api/auth/google': ['POST'],
  '/api/auth/logout': ['POST'],
  '/api/me': ['GET', 'PATCH'],
  '/api/me/posts': ['GET'],
  '/api/me/comments': ['GET'],
  '/api/admin/session': ['GET', 'POST'],
  '/api/intake/config': ['GET'],
  '/api/consultations': ['POST'],
  '/api/inquiries': ['POST'],
  '/api/admin/consultations': ['GET'],
  '/api/admin/inquiries': ['GET'],
  '/api/admin/intake-assignees': ['GET'],
  '/api/admin/audit-events': ['GET'],
};

// Only imported tests can supply dependencies. Runtime variables cannot enable
// mock login or replace Google's verification keys in the deployed Worker.
export function createWorker({ googleKeys, turnstileFetch, clock = () => Math.floor(Date.now() / 1000) } = {}) {
  return {
    async fetch(request, env) {
      try {
        const path = new URL(request.url).pathname;
        const intakeDetail = path.match(/^\/api\/admin\/(consultations|inquiries)\/([^/]+)$/);
        const methods = METHODS[path] ?? (intakeDetail ? ['GET', 'PATCH'] : null);
        if (!methods) throw new HttpError(404, 'NOT_FOUND');
        if (!methods.includes(request.method)) throw new HttpError(405, 'METHOD_NOT_ALLOWED', { Allow: methods.join(', ') });
        const now = clock();
        if (path === '/api/health') {
          await Promise.all([
            env.CONTENT_DB.prepare('SELECT id FROM published_posts LIMIT 0').all(),
            env.OPS_DB.prepare('SELECT id, admin_code_fingerprint, member_session_id FROM sessions LIMIT 0').all(),
            env.OPS_DB.prepare('SELECT token_hash FROM auth_challenges LIMIT 0').all(),
            env.OPS_DB.prepare('SELECT key_hash FROM auth_rate_limits LIMIT 0').all(),
            env.OPS_DB.prepare('SELECT token_hash, expires_at FROM intake_token_redemptions LIMIT 0').all(),
            env.OPS_DB.prepare('SELECT id, version, confirmed_time FROM consultations LIMIT 0').all(),
            env.OPS_DB.prepare('SELECT id, version FROM inquiries LIMIT 0').all(),
          ]);
          return json({ status: 'ok', stage: 3 });
        }
        if (path === '/api/auth/config') {
          try {
            const settings = config(env);
            return json({ configured: true, clientId: settings.clientId,
              termsVersion: settings.termsVersion, privacyVersion: settings.privacyVersion, languages: LANGUAGES });
          } catch (error) {
            if (!(error instanceof HttpError)) throw error;
            return json({ configured: false, error: 'AUTH_NOT_CONFIGURED' }, 503);
          }
        }
        checkOrigin(request, env, !['GET', 'HEAD'].includes(request.method));
        if (path === '/api/intake/config') return intakeConfig(env);
        if (path === '/api/consultations' || path === '/api/inquiries') {
          return await submitIntake(request, env, await readJson(request, 65_536), path.slice('/api/'.length), now, turnstileFetch);
        }
        if (intakeDetail || ['/api/admin/consultations', '/api/admin/inquiries', '/api/admin/intake-assignees', '/api/admin/audit-events'].includes(path)) {
          const permission = path === '/api/admin/audit-events' ? 'audit:read'
            : request.method === 'PATCH' ? 'consultations:write' : 'consultations:read';
          const admin = await requireAdmin(request, env, now, permission);
          if (path === '/api/admin/audit-events') return await intakeAudit(request, env);
          if (path === '/api/admin/intake-assignees') return await intakeAssignees(request, env);
          const kind = intakeDetail ? intakeDetail[1] : path.slice('/api/admin/'.length);
          if (!intakeDetail) return await listIntake(request, env, kind);
          if (request.method === 'GET') return await readIntake(request, env, kind, intakeDetail[2], admin, now);
          await checkCsrf(request, admin.token);
          return await updateIntake(request, env, await readJson(request, 65_536), kind, intakeDetail[2], admin, now);
        }
        if (path === '/api/auth/challenge') return await createChallenge(request, env, now);
        if (path === '/api/auth/google') return await googleLogin(request, env, await readJson(request), now, googleKeys);
        if (path === '/api/auth/logout') return await logout(request, env, now);
        if (path === '/api/admin/session') {
          if (request.method === 'POST') {
            const member = await requireMember(request, env, now);
            return await createAdminSession(request, env, await readJson(request), member, now);
          }
          const admin = await requireAdmin(request, env, now);
          return json({ user: publicUser(admin.session), role: admin.role, permissions: admin.permissions,
            csrfToken: await csrfFor(admin.token), expiresAt: admin.session.expires_at });
        }
        const member = await requireMember(request, env, now);
        if (path === '/api/me') {
          if (request.method === 'PATCH') {
            await checkCsrf(request, member.token);
            return await updateProfile(env, await readJson(request), member, now);
          }
          return json({ user: publicUser(member.session), csrfToken: await csrfFor(member.token), expiresAt: member.session.expires_at });
        }
        return await ownActivity(request, env, member, path.endsWith('/posts') ? 'posts' : 'comments');
      } catch (error) {
        if (error instanceof HttpError) return json({ error: error.code }, error.status, error.headers);
        return json({ status: 'unavailable' }, 503);
      }
    },
  };
}

export default createWorker();

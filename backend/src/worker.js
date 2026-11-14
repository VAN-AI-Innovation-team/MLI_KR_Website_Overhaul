import { createAdminSession, createChallenge, googleLogin, logout, requireAdmin, requireMember } from './auth.js';
import { LANGUAGES, HttpError, checkCsrf, checkOrigin, config, csrfFor, json, publicUser, readJson } from './http.js';
import { ownActivity, updateProfile } from './profile.js';

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
};

// Only imported tests can supply dependencies. Runtime variables cannot enable
// mock login or replace Google's verification keys in the deployed Worker.
export function createWorker({ googleKeys, clock = () => Math.floor(Date.now() / 1000) } = {}) {
  return {
    async fetch(request, env) {
      try {
        const path = new URL(request.url).pathname;
        const methods = METHODS[path];
        if (!methods) throw new HttpError(404, 'NOT_FOUND');
        if (!methods.includes(request.method)) throw new HttpError(405, 'METHOD_NOT_ALLOWED', { Allow: methods.join(', ') });
        const now = clock();
        if (path === '/api/health') {
          await Promise.all([
            env.CONTENT_DB.prepare('SELECT id FROM published_posts LIMIT 0').all(),
            env.OPS_DB.prepare('SELECT id, admin_code_fingerprint, member_session_id FROM sessions LIMIT 0').all(),
            env.OPS_DB.prepare('SELECT token_hash FROM auth_challenges LIMIT 0').all(),
            env.OPS_DB.prepare('SELECT key_hash FROM auth_rate_limits LIMIT 0').all(),
          ]);
          return json({ status: 'ok', stage: 2 });
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

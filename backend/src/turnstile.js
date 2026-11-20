import { HttpError, originConfig } from './http.js';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Dependency injection is available only to imported tests. No environment
// setting can bypass Siteverify or redirect it to a caller-controlled endpoint.
export async function verifyTurnstile(request, env, token, action, now, send = fetch) {
  if (typeof token !== 'string' || !token.trim() || token.length > 2048) {
    throw new HttpError(400, 'TURNSTILE_TOKEN_REQUIRED');
  }
  let result;
  try {
    const ip = request.headers.get('CF-Connecting-IP');
    const response = await send(SITEVERIFY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token,
        ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(5000),
      // Workers supports manual/follow. A redirect is not a successful
      // Siteverify response and must never forward the secret to another URL.
      redirect: 'manual',
    });
    if (!response.ok) throw new Error();
    result = await response.json();
    if (!result || typeof result !== 'object' || typeof result.success !== 'boolean') throw new Error();
  } catch {
    throw new HttpError(503, 'TURNSTILE_UNAVAILABLE');
  }
  if (!result.success && Array.isArray(result['error-codes']) && result['error-codes'].some(
    code => ['missing-input-secret', 'invalid-input-secret', 'internal-error'].includes(code),
  )) throw new HttpError(503, 'TURNSTILE_UNAVAILABLE');
  const challengeAt = typeof result.challenge_ts === 'string' ? Date.parse(result.challenge_ts) / 1000 : NaN;
  if (!result.success || result.hostname !== new URL(originConfig(env).origin).hostname
    || result.action !== action || !Number.isFinite(challengeAt) || challengeAt < now - 300 || challengeAt > now + 60) {
    throw new HttpError(403, 'TURNSTILE_INVALID');
  }
}

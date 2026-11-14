export const LANGUAGES = ['ko', 'en', 'zh-CN', 'es', 'fr', 'ja'];
export const MEMBER_TTL = 24 * 60 * 60;
export const ADMIN_TTL = 8 * 60 * 60;
export const ADMIN_IDLE = 30 * 60;
export const CHALLENGE_TTL = 10 * 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export class HttpError extends Error {
  constructor(status, code, headers = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export function json(body, status = 200, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...extraHeaders,
    },
  });
}

export function config(env) {
  try {
    const origin = new URL(env.APP_ORIGIN);
    const local = origin.protocol === 'http:' && LOOPBACK.has(origin.hostname)
      && env.ALLOW_INSECURE_LOCAL_COOKIES === 'true';
    if ((!local && origin.protocol !== 'https:') || origin.username || origin.password
      || origin.pathname !== '/' || origin.search || origin.hash) throw new Error();
    if (typeof env.GOOGLE_CLIENT_ID !== 'string'
      || !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(env.GOOGLE_CLIENT_ID)) throw new Error();
    if (!env.TERMS_VERSION?.trim() || !env.PRIVACY_VERSION?.trim()) throw new Error();
    return {
      origin: origin.origin, clientId: env.GOOGLE_CLIENT_ID,
      termsVersion: env.TERMS_VERSION.trim(), privacyVersion: env.PRIVACY_VERSION.trim(),
    };
  } catch {
    throw new HttpError(503, 'AUTH_NOT_CONFIGURED');
  }
}

export function checkOrigin(request, env, required = false) {
  const { origin } = config(env);
  const supplied = request.headers.get('Origin');
  if ((required && supplied !== origin) || (supplied !== null && supplied !== origin)
    || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    throw new HttpError(403, 'ORIGIN_FORBIDDEN');
  }
}

export async function readJson(request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'JSON_REQUIRED');
  }
  // Enforce the limit while reading, including requests with no Content-Length.
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'INVALID_JSON');
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16_384) {
      await reader.cancel();
      throw new HttpError(413, 'BODY_TOO_LARGE');
    }
    chunks.push(value);
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'INVALID_JSON');
  }
}

export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function equalStrings(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export function cookieSettings(request, env) {
  const url = new URL(request.url);
  const insecure = env.ALLOW_INSECURE_LOCAL_COOKIES === 'true'
    && url.protocol === 'http:' && LOOPBACK.has(url.hostname)
    && config(env).origin.startsWith('http:');
  return { prefix: insecure ? 'mli_' : '__Host-mli_', secure: !insecure };
}

export function readCookie(request, env, kind) {
  const name = `${cookieSettings(request, env).prefix}${kind}`;
  const values = (request.headers.get('Cookie') ?? '').split(';')
    .map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return TOKEN_PATTERN.test(value) ? value : null;
}

export function setCookie(response, request, env, kind, value, maxAge) {
  const { prefix, secure } = cookieSettings(request, env);
  response.headers.append('Set-Cookie', `${prefix}${kind}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}

export const csrfFor = token => sha256(`mli-csrf:${token}`);

export async function checkCsrf(request, token) {
  if (!equalStrings(request.headers.get('X-CSRF-Token'), await csrfFor(token))) {
    throw new HttpError(403, 'CSRF_INVALID');
  }
}

export function publicUser(row) {
  return { id: row.user_id, nickname: row.nickname, preferredLanguage: row.preferred_language };
}

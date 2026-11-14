import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import { HttpError } from './http.js';

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), {
  timeoutDuration: 5000,
});

// Tests supply a local public key resolver here. Runtime configuration cannot
// override Google's key URL, issuer, algorithm, or signature verification.
export async function verifyGoogle(credential, clientId, now, keys = googleKeys) {
  if (typeof credential !== 'string' || credential.length > 12_000) {
    throw new HttpError(401, 'GOOGLE_TOKEN_INVALID');
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(credential, keys, {
      algorithms: ['RS256'],
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: clientId,
      requiredClaims: ['exp', 'iat', 'sub', 'email', 'email_verified', 'nonce'],
      maxTokenAge: '10m',
      clockTolerance: 5,
      currentDate: new Date(now * 1000),
    }));
  } catch (error) {
    if (error instanceof errors.JWKSTimeout || !(error instanceof errors.JOSEError)) {
      throw new HttpError(503, 'GOOGLE_VERIFICATION_UNAVAILABLE');
    }
    throw new HttpError(401, 'GOOGLE_TOKEN_INVALID');
  }
  if (typeof payload.sub !== 'string' || !payload.sub.trim() || payload.sub.length > 255
    || typeof payload.email !== 'string' || payload.email.length > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email) || payload.email_verified !== true
    || typeof payload.nonce !== 'string'
    || (payload.azp !== undefined && payload.azp !== clientId)) {
    throw new HttpError(401, 'GOOGLE_TOKEN_INVALID');
  }
  return payload;
}

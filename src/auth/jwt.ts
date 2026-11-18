import { createHmac, timingSafeEqual } from 'node:crypto';

export interface AccessClaims {
  iss: string;
  aud: string;
  sub: string;
  client_id: string;
  scope: string;
  iat: number;
  exp: number;
  jti: string;
  gen: number;
}

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

function sign(data: string, key: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function signJwt(claims: AccessClaims, key: string): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const data = `${HEADER}.${body}`;
  return `${data}.${sign(data, key).toString('base64url')}`;
}

/** Returns claims when signature, alg and shape are valid. Does NOT check exp/aud/gen (caller does). */
export function verifyJwt(token: string, key: string): AccessClaims | undefined {
  if (token.length > 4096) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const [h, p, s] = parts as [string, string, string];
  try {
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg?: unknown };
    if (header.alg !== 'HS256') return undefined;
    const expected = sign(`${h}.${p}`, key);
    const given = Buffer.from(s, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    const c = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Partial<AccessClaims>;
    if (
      typeof c.iss !== 'string' || typeof c.aud !== 'string' || typeof c.client_id !== 'string' ||
      typeof c.scope !== 'string' || typeof c.jti !== 'string' ||
      typeof c.exp !== 'number' || typeof c.iat !== 'number' || typeof c.gen !== 'number' || c.sub !== 'owner'
    ) return undefined;
    return c as AccessClaims;
  } catch {
    return undefined;
  }
}

/** Domain-separated sub-key so the consent tokens can never be confused with JWT signatures. */
export function deriveKey(signingKey: string, label: string): string {
  return createHmac('sha256', signingKey).update(label).digest('base64url');
}

export function signBlob(payload: unknown, key: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body, key).toString('base64url')}`;
}

export function verifyBlob<T>(blob: string, key: string): T | undefined {
  if (blob.length > 8192) return undefined;
  const i = blob.indexOf('.');
  if (i < 1) return undefined;
  const body = blob.slice(0, i);
  const given = Buffer.from(blob.slice(i + 1), 'base64url');
  const expected = sign(body, key);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

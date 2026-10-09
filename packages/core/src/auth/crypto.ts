import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * API keys (plan §5.4):
 *   raw   = "fpm_" + 40 lowercase hex chars (20 random bytes)
 *   hash  = SHA-256(raw) hex   (only the hash is stored)
 *   prefix= first 12 chars of the raw value, incl. "fpm_" (safe for logs/UIs)
 * The raw value is shown exactly once at creation; never logged, never stored.
 * The §14 log-redaction grep `fpm_[a-z0-9]{20,}` will catch any accidental
 * leak of a raw key.
 */
export interface GeneratedApiKey {
  raw: string;
  key_hash: string;
  prefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  const raw = `fpm_${randomBytes(20).toString('hex')}`;
  return { raw, key_hash: hashApiKey(raw), prefix: raw.slice(0, 12) };
}

export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function verifyApiKey(raw: string, storedHashHex: string): boolean {
  const a = Buffer.from(hashApiKey(raw), 'hex');
  let b: Buffer;
  try {
    b = Buffer.from(storedHashHex, 'hex');
  } catch {
    return false;
  }
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Session tokens (plan §5.3): random 32 bytes, hex-encoded; store SHA-256 in
 * `sessions.token_hash`, send raw value as an httpOnly cookie. Same pattern
 * as API keys: raw never lands in the DB.
 */
export function generateSessionToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('hex');
  return { raw, hash: createHash('sha256').update(raw).digest('hex') };
}

/** CSRF token for double-submit cookie pattern (plan §5.3). */
export function generateCsrfToken(): string {
  return randomBytes(24).toString('base64url');
}

import crypto from 'node:crypto';
import { extractItemKeys, extractClosingKeys } from '@forgepm/core';

/**
 * GitHub webhook signature verification (plan §9.1). Constant-time compare of
 * `sha256=<hmac(secret, body)>`. A malformed header or length mismatch is
 * rejected without a content-based early return.
 */
export function verifyWebhookSignature(secret: string, rawBody: string | Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const m = /^sha256=([0-9a-f]+)$/i.exec(header.trim());
  if (!m) return false;
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const a = Buffer.from(m[1], 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export { extractItemKeys, extractClosingKeys };

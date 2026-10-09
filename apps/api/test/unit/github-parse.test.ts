import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { verifyWebhookSignature } from '../../src/modules/github/parse';

function sign(secret: string, body: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}`;
}

describe('verifyWebhookSignature (plan §9.1)', () => {
  const secret = 'whsec_top';
  const body = JSON.stringify({ hello: 'world' });

  it('accepts a valid signature (string + Buffer body)', () => {
    expect(verifyWebhookSignature(secret, body, sign(secret, body))).toBe(true);
    expect(verifyWebhookSignature(secret, Buffer.from(body), sign(secret, body))).toBe(true);
  });

  it('rejects missing / malformed headers', () => {
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
    expect(verifyWebhookSignature(secret, body, 'sha1=abc')).toBe(false);
    expect(verifyWebhookSignature(secret, body, 'not-a-sig')).toBe(false);
  });

  it('rejects wrong secret, body mismatch, truncated sig', () => {
    expect(verifyWebhookSignature(secret, body, sign('other', body))).toBe(false);
    expect(verifyWebhookSignature(secret, body + '!', sign(secret, body))).toBe(false);
    const good = sign(secret, body);
    expect(verifyWebhookSignature(secret, body, good.slice(0, good.length - 1))).toBe(false);
  });
});

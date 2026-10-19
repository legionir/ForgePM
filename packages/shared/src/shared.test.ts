import { describe, it, expect } from 'vitest';
import { decodeCursor, encodeCursor, listQuerySchema, PAGINATION_MAX_LIMIT } from './pagination';
import { AppError } from './errors';
import { ERROR_CODES } from './error-codes';
import { factInputSchema, factPromotionInputSchema } from './schemas-exec';

describe('pagination cursor', () => {
  it('round-trips createdAt and id', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const c = encodeCursor(now.toISOString(), '018f-abc');
    const d = decodeCursor(c);
    expect(d.createdAt).toBe(now.toISOString());
    expect(d.id).toBe('018f-abc');
  });

  it('rejects malformed cursor', () => {
    expect(() => decodeCursor('zzz_not_hex')).toThrowError(/invalid cursor/);
  });
});

describe('listQuerySchema', () => {
  it('defaults limit to 50', () => {
    expect(listQuerySchema.parse({}).limit).toBe(50);
  });

  it('caps limit at the maximum', () => {
    expect(() => listQuerySchema.parse({ limit: PAGINATION_MAX_LIMIT + 1 })).toThrowError();
  });
});

describe('PE-11 fact schemas', () => {
  const fact = {
    key: 'runtime.version',
    value: 'the runtime uses the stable version setting',
    kind: 'fact',
    source: 'agent_guess',
  };

  it('refuses guess-as-fact with an actionable assumption instruction', () => {
    const parsed = factInputSchema.safeParse(fact);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toContain("use kind='assumption'");
  });

  it('accepts an assumption and requires a reason for human promotion', () => {
    expect(factInputSchema.safeParse({ ...fact, kind: 'assumption' }).success).toBe(true);
    expect(factPromotionInputSchema.safeParse({ source: 'human' }).success).toBe(false);
    expect(factPromotionInputSchema.safeParse({ reason: 'a human checked and confirms the fact' }).success).toBe(true);
  });
});

describe('AppError', () => {
  it('maps code to http status and serialises with request id', () => {
    const e = new AppError('MODULE_DISABLED', 'off');
    expect(e.httpStatus).toBe(503);
    expect(e.toJSON('req-1')).toEqual({ error: { code: 'MODULE_DISABLED', message: 'off', request_id: 'req-1' } });
  });

  it('includes details only when present', () => {
    expect(new AppError('VALIDATION_ERROR', 'bad').toJSON()).not.toHaveProperty('error.details');
    expect(new AppError('VALIDATION_ERROR', 'bad', { x: 1 }).toJSON().error).toHaveProperty('details');
  });

  it('every declared code has a status', () => {
    for (const code of Object.keys(ERROR_CODES)) {
      expect(ERROR_CODES[code as keyof typeof ERROR_CODES]).toBeGreaterThanOrEqual(400);
    }
  });
});

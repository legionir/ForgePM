import { describe, it, expect } from 'vitest';
import { decodeCursor, encodeCursor, listQuerySchema, PAGINATION_MAX_LIMIT } from './pagination';
import { AppError } from './errors';
import { ERROR_CODES } from './error-codes';

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

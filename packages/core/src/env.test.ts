import { describe, it, expect } from 'vitest';
import { parseEnv } from './env';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  FORGEPM_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('parseEnv', () => {
  it('applies defaults for optional values', () => {
    const env = parseEnv({ ...base });
    expect(env.PORT).toBe(3001);
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_DOCS_ENABLED).toBe(false);
    expect(env.METRICS_ENABLED).toBe(false);
  });

  it('coerces boolean-ish env strings', () => {
    expect(parseEnv({ ...base, API_DOCS_ENABLED: 'true' }).API_DOCS_ENABLED).toBe(true);
  });

  it('rejects a bad DATABASE_URL', () => {
    expect(() => parseEnv({ ...base, DATABASE_URL: 'not-a-url' })).toThrowError(/DATABASE_URL/);
  });

  it('rejects a non-32-byte secret key', () => {
    expect(() => parseEnv({ ...base, FORGEPM_SECRET_KEY: 'short' })).toThrowError(/FORGEPM_SECRET_KEY/);
  });

  it('rejects a too-short admin password when provided', () => {
    expect(() =>
      parseEnv({ ...base, FORGEPM_ADMIN_EMAIL: 'a@b.co', FORGEPM_ADMIN_PASSWORD: '123' }),
    ).toThrowError(/FORGEPM_ADMIN_PASSWORD/);
  });
});

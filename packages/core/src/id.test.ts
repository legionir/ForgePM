import { describe, it, expect } from 'vitest';
import { newId } from './id';
import { scopedDb } from './db/scoped';

describe('newId', () => {
  it('produces a UUIDv7 (version nibble = 7)', () => {
    const id = newId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('is unique', () => {
    const set = new Set(Array.from({ length: 1000 }, () => newId()));
    expect(set.size).toBe(1000);
  });
});

describe('scopedDb', () => {
  it('requires an organization id', () => {
    expect(() =>
      scopedDb({} as never, { organizationId: '', requestId: 'r' }),
    ).toThrowError(/organization context/);
  });

  it('carries org and request id through', () => {
    const s = scopedDb({} as never, { organizationId: 'org-1', requestId: 'req-1' });
    expect(s.organizationId).toBe('org-1');
    expect(s.requestId).toBe('req-1');
  });
});

import { describe, it, expect } from 'vitest';
import { can, authorize } from './matrix';
import type { Action } from './matrix';

const ALL: Action[] = [
  'org:manage',
  'users:manage',
  'settings:system',
  'project:create',
  'project:archive',
  'project:read',
  'project:write',
  'project:settings',
  'project:members',
  'apikeys:self',
  'apikeys:manage',
  'audit:read',
  'jobs:read',
  'secrets:manage',
  'plan:approve',
  'plan:apply',
];

describe('permission matrix (plan §5)', () => {
  it('owner can do everything', () => {
    for (const a of ALL) expect(can({ orgRole: 'owner', projectRole: null }, a)).toBe(true);
  });

  it('admin cannot org:manage or settings:system (owner-only)', () => {
    expect(can({ orgRole: 'admin', projectRole: null }, 'org:manage')).toBe(false);
    expect(can({ orgRole: 'admin', projectRole: null }, 'settings:system')).toBe(false);
    expect(can({ orgRole: 'admin', projectRole: null }, 'project:create')).toBe(true);
    expect(can({ orgRole: 'admin', projectRole: null }, 'audit:read')).toBe(true);
    expect(can({ orgRole: 'admin', projectRole: null }, 'users:manage')).toBe(true);
    expect(can({ orgRole: 'admin', projectRole: null }, 'apikeys:manage')).toBe(true);
    expect(can({ orgRole: 'admin', projectRole: null }, 'secrets:manage')).toBe(true);
    expect(can({ orgRole: 'admin', projectRole: null }, 'jobs:read')).toBe(true);
    expect(can({ orgRole: 'admin', projectRole: null }, 'plan:approve')).toBe(true);
    expect(can({ orgRole: 'admin', projectRole: null }, 'plan:apply')).toBe(true);
  });

  it('member is denied every privileged action but keeps apikeys:self', () => {
    for (const a of ALL) {
      const allow = can({ orgRole: 'member', projectRole: null }, a);
      if (a === 'apikeys:self') expect(allow).toBe(true);
      else expect(allow).toBe(false);
    }
  });

  it('viewer: only apikeys:self', () => {
    for (const a of ALL) {
      const allow = can({ orgRole: 'viewer', projectRole: null }, a);
      expect(allow).toBe(a === 'apikeys:self');
    }
  });

  it('null org role: nothing except project-scoped reads when projectRole present', () => {
    expect(can({ orgRole: null, projectRole: 'lead' }, 'project:read')).toBe(true);
    expect(can({ orgRole: null, projectRole: 'lead' }, 'project:create')).toBe(false);
    expect(can({ orgRole: null, projectRole: null }, 'project:read')).toBe(false);
    expect(can({ orgRole: null, projectRole: 'lead' }, 'apikeys:self')).toBe(false);
  });

  it('project roles grant write/settings/members/plan within that project', () => {
    for (const role of ['lead', 'contributor', 'viewer'] as const) {
      const w = can({ orgRole: 'member', projectRole: role }, 'project:write');
      const s = can({ orgRole: 'member', projectRole: role }, 'project:settings');
      const m = can({ orgRole: 'member', projectRole: role }, 'project:members');
      const r = can({ orgRole: 'member', projectRole: role }, 'project:read');
      const pa = can({ orgRole: 'member', projectRole: role }, 'plan:approve');
      if (role === 'lead') {
        expect([w, s, m, r, pa]).toEqual([true, true, true, true, true]);
      } else if (role === 'contributor') {
        expect([w, s, m, r, pa]).toEqual([true, false, false, true, false]);
      } else {
        expect([w, s, m, r, pa]).toEqual([false, false, false, true, false]);
      }
    }
  });

  it('authorize throws on failure and is silent on success', () => {
    expect(() => authorize({ orgRole: 'viewer', projectRole: null }, 'project:create')).toThrowError(/FORBIDDEN|not allowed/);
    expect(() => authorize({ orgRole: 'owner', projectRole: null }, 'project:create')).not.toThrow();
  });
});

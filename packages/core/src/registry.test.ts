import { describe, it, expect } from 'vitest';
import { AppError } from '@forgepm/shared';
import { ModuleRegistry } from './modules/registry';

// registry only needs a DB for the settings lookups; enable/disable on an
// invalid module short-circuits before touching it, so a stub suffices here.
const anyDb = {} as never;

describe('ModuleRegistry (pure parts)', () => {
  it('registration means "exists", separate from enabled', () => {
    const reg = new ModuleRegistry();
    reg.register({ name: 'github' });
    expect(reg.isRegistered('github')).toBe(true);
    expect(reg.isRegistered('nope')).toBe(false);
    expect(reg.list().map((d) => d.name)).toEqual(['github']);
  });

  it('enable rejects an unregistered module before any DB write', async () => {
    const reg = new ModuleRegistry();
    await expect(reg.enable(anyDb, 'ghost', null)).rejects.toBeInstanceOf(AppError);
  });

  it('enable runs validateConfig and propagates its failure (plan §3b-1.4)', async () => {
    const reg = new ModuleRegistry();
    reg.register({
      name: 'github',
      validateConfig: async () => {
        throw new AppError('VALIDATION_ERROR', 'App ID missing');
      },
    });
    // enable(orgId set) resolves upsertSetting BEFORE validateConfig is run?
    // Implementation: validateConfig first, so the write must never happen.
    await expect(reg.enable(anyDb, 'github', 'org-1')).rejects.toThrowError(/App ID missing/);
  });
});

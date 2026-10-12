import { describe, it, expect, vi } from 'vitest';

// Minimal unit test: validateConfig requires all three secrets.
// We stub Db at the module level via dynamic import.

describe('POU-36: github/config validateConfig', () => {
  it('throws when no org exists', async () => {
    const { validateConfig } = await import('../../../apps/api/src/modules/github/config');
    const db = {
      selectFrom: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      executeTakeFirst: vi.fn().mockResolvedValue(undefined),
    } as never;
    await expect(validateConfig(db)).rejects.toThrow('no organization yet');
  });

  it('throws when any of app_id, private_key, webhook_secret is missing', async () => {
    const db = {
      selectFrom: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      executeTakeFirst: vi.fn().mockResolvedValue({ id: 'org-1' }),
      transaction: vi.fn().mockReturnValue({ execute: vi.fn() }),
    } as never;

    // Save original env then restore after
    const origAppId = process.env.GITHUB_APP_ID;
    const origPk = process.env.GITHUB_APP_PRIVATE_KEY;
    const origWs = process.env.GITHUB_WEBHOOK_SECRET;

    // Case: only webhook_secret set (app_id and pk missing)
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    process.env.GITHUB_WEBHOOK_SECRET = 'ws1';

    // Stub getSecret for DB values (all undefined here)
    vi.doMock('@forgepm/core', () => ({
      ...vi.importActual('@forgepm/core'),
      activeCipher: () => 0,
      getSecret: vi.fn().mockResolvedValue(null),
    }));

    // Re-import to pick up stubbed core
    vi.resetModules();
    const { validateConfig: vc2 } = await import('../../../apps/api/src/modules/github/config');

    await expect(vc2(db)).rejects.toThrow('missing: github.app_id, github.app_private_key');

    process.env.GITHUB_APP_ID = origAppId ?? '';
    process.env.GITHUB_APP_PRIVATE_KEY = origPk ?? '';
    process.env.GITHUB_WEBHOOK_SECRET = origWs ?? '';
    vi.doUnmock('@forgepm/core');
  });

  it('succeeds when all three are present (env)', async () => {
    const origAppId = process.env.GITHUB_APP_ID;
    const origPk = process.env.GITHUB_APP_PRIVATE_KEY;
    const origWs = process.env.GITHUB_WEBHOOK_SECRET;
    process.env.GITHUB_APP_ID = '123';
    process.env.GITHUB_APP_PRIVATE_KEY = 'pk';
    process.env.GITHUB_WEBHOOK_SECRET = 'ws';

    const { validateConfig } = await import('../../../apps/api/src/modules/github/config');
    const db = {
      selectFrom: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      executeTakeFirst: vi.fn().mockResolvedValue({ id: 'org-1' }),
      transaction: vi.fn().mockReturnValue({ execute: vi.fn() }),
    } as never;

    await expect(validateConfig(db)).resolves.toBeUndefined();

    process.env.GITHUB_APP_ID = origAppId;
    process.env.GITHUB_APP_PRIVATE_KEY = origPk;
    process.env.GITHUB_WEBHOOK_SECRET = origWs;
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { AppError } from '@forgepm/shared';
import { ModuleRegistry, getEffective, upsertSetting, deleteSetting, unitOfWork, newId } from '@forgepm/core';
import { createHarness, type Harness } from './harness';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.cleanup();
});
beforeEach(async () => {
  await h.reset();
});

describe('settings constraints (plan §3b-2, §5.7)', () => {
  it('rejects two system-scope rows for the same key (NULLS-NOT-DISTINCT emulation)', async () => {
    await upsertSetting(h.db, 'system', null, 'a', 1);
    // direct duplicate insert (bypassing upsert) must hit the unique index
    await expect(
      h.db
        .insertInto('settings')
        .values({ id: newId(), scope: 'system', scope_id: null, key: 'a', value: 2 as never })
        .execute(),
    ).rejects.toThrowError();
  });

  it('enforces the scope/scope_id CHECK', async () => {
    await expect(
      h.db
        .insertInto('settings')
        .values({ id: newId(), scope: 'system', scope_id: newId(), key: 'bad', value: 1 as never })
        .execute(),
    ).rejects.toThrowError(); // system scope must have NULL scope_id
  });

  it('resolves inherited + overridden effective value with source (project wins)', async () => {
    const orgId = newId();
    const projectId = newId();
    await upsertSetting(h.db, 'system', null, 'review.issue_policy', 'X');
    await upsertSetting(h.db, 'project', projectId, 'review.issue_policy', 'Y');

    const proj = await getEffective(h.db, 'review.issue_policy', orgId, projectId);
    expect(proj).toMatchObject({ value: 'Y', source: 'project' });

    // a DIFFERENT project must NOT see projectId's override (tenancy isolation)
    const otherProjectId = newId();
    const other = await getEffective(h.db, 'review.issue_policy', orgId, otherProjectId);
    expect(other).toMatchObject({ value: 'X', source: 'system' });

    // deleting the override falls back to inheritance
    await deleteSetting(h.db, 'project', projectId, 'review.issue_policy');
    const back = await getEffective(h.db, 'review.issue_policy', orgId, projectId);
    expect(back).toMatchObject({ value: 'X', source: 'system' });
  });
});

describe('jobs CHECK constraints', () => {
  it('rejects an unknown job status', async () => {
    await expect(
      h.db
        .insertInto('jobs')
        .values({ id: newId(), queue: 'q', type: 't', status: 'bogus' as never, payload: {} as never })
        .execute(),
    ).rejects.toThrowError();
  });
});

describe('unitOfWork (plan §3b-3)', () => {
  it('rolls back domain write together with the outbox row', async () => {
    await expect(
      unitOfWork(h.db, async (ctx) => {
        await upsertSetting(ctx.tx, 'system', null, 'k', 1);
        await ctx.enqueue('test.topic', { a: 1 });
        throw new AppError('CONFLICT', 'boom'); // force rollback
      }),
    ).rejects.toBeInstanceOf(AppError);

    expect(await getEffective(h.db, 'k', null, null)).toBeUndefined();
    const rows = await h.db.selectFrom('outbox').selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it('commits both the setting and the outbox row on success', async () => {
    await unitOfWork(h.db, async (ctx) => {
      await upsertSetting(ctx.tx, 'system', null, 'ok', 5);
      await ctx.enqueue('test.topic', { b: 2 });
    });
    expect(await getEffective(h.db, 'ok', null, null)).toMatchObject({ value: 5 });
    const rows = await h.db.selectFrom('outbox').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.topic).toBe('test.topic');
    expect(rows[0]!.dispatched_at).toBeNull();
  });
});

describe('ModuleRegistry (plan §3b-1)', () => {
  it('defaults to disabled and flips via settings without restart', async () => {
    const reg = new ModuleRegistry();
    reg.register({ name: 'sample', validateConfig: async () => {} });
    expect(await reg.isEnabled(h.db, 'sample', null, null)).toBe(false);

    await reg.enable(h.db, 'sample', null);
    expect(await reg.isEnabled(h.db, 'sample', null, null)).toBe(true);

    await reg.disable(h.db, 'sample', null);
    expect(await reg.isEnabled(h.db, 'sample', null, null)).toBe(false);
  });

  it('rejects enabling an unregistered module', async () => {
    const reg = new ModuleRegistry();
    await expect(reg.enable(h.db, 'ghost', null)).rejects.toBeInstanceOf(AppError);
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setActiveCipher,
  createCipher,
  newId,
  upsertSetting,
  isModuleEnabled,
  setReviewProviderResolver,
  setDiffProvider,
  StubProvider,
  type Logger,
} from '@forgepm/core';
import { createLogger } from '@forgepm/core';
import { handlers } from '../../apps/worker/src/handlers';
import { createHarness, type Harness } from './harness';
import { seedOrg } from './seed';

const log: Logger = createLogger('fatal');
let h: Harness;

beforeAll(async () => {
  setActiveCipher(createCipher(Buffer.alloc(32, 7)));
  h = await createHarness();
});
afterAll(async () => {
  setReviewProviderResolver(async () => null);
  setDiffProvider(null);
  await h.cleanup();
});
beforeEach(async () => {
  await h.reset();
  setDiffProvider(null);
  setReviewProviderResolver(async () => null);
});

async function seedProject(email: string): Promise<{ orgId: string; projectId: string; repoId: string }> {
  const seed = await seedOrg(h.db, { email, password: 'hunter22x', projectKey: 'WKR' });
  const repoId = newId();
  await h.db.insertInto('repositories').values({ id: repoId, organization_id: seed.organizationId, provider: 'github', external_id: 'r-9', full_name: 'org/rich' }).execute();
  await h.db.insertInto('project_repositories').values({ project_id: seed.projectId, repository_id: repoId, organization_id: seed.organizationId }).execute();
  return { orgId: seed.organizationId, projectId: seed.projectId, repoId };
}

async function storeDelivery(orgId: string, id: string, event: string, payload: unknown): Promise<void> {
  await h.db.insertInto('webhook_deliveries').values({ id: newId(), organization_id: orgId, delivery_id: id, event, payload: JSON.parse(JSON.stringify(payload)) }).execute();
}
function fakeJob(jobId: string, deliveryId: string): never {
  return { id: jobId, name: 'github.process_delivery', data: { job_id: jobId, payload: { delivery_id: deliveryId } } } as never;
}
function reviewJob(jobId: string, payload: Record<string, unknown>): never {
  return { id: jobId, name: 'review.code_run', data: { job_id: jobId, payload } } as never;
}

const prPayload = (sha: string) => ({
  action: 'opened',
  repository: { id: 'r-9', full_name: 'org/rich' },
  pull_request: { id: 'pr-9', number: 9, title: 'x', state: 'open', draft: false, head: { ref: 'b', sha } },
});

describe('worker webhook-triggered Code Review (plan §10 acceptance)', () => {
  it('code_review OFF: a PR delivery creates NO review job + no run', async () => {
    const { orgId } = await seedProject('wk-off@x.io');
    await storeDelivery(orgId, 'd-off', 'pull_request', prPayload('sha-off'));
    await handlers['github.process_delivery']!(fakeJob(newId(), 'd-off'), h.db, log);
    const outbox = await h.db.selectFrom('outbox').select('id').where('topic', '=', 'review.code_run').execute();
    expect(outbox).toHaveLength(0);
    const runs = await h.db.selectFrom('review_runs').select('id').execute();
    expect(runs).toHaveLength(0);
  });

  it('auto_run OFF (module on): PR delivery does not enqueue a review job', async () => {
    const { orgId, projectId } = await seedProject('wk-auto@x.io');
    await upsertSetting(h.db, 'project', projectId, 'modules.code_review.enabled', true);
    await upsertSetting(h.db, 'project', projectId, 'review.auto_run', false);
    await storeDelivery(orgId, 'd-auto', 'pull_request', prPayload('sha-auto'));
    await handlers['github.process_delivery']!(fakeJob(newId(), 'd-auto'), h.db, log);
    const jobs = await h.db.selectFrom('jobs').select('id').where('type', '=', 'review.code_run').execute();
    expect(jobs).toHaveLength(0);
  });

  it('module ON + auto_run ON: PR delivery enqueues exactly one review job', async () => {
    const { orgId, projectId } = await seedProject('wk-on@x.io');
    await upsertSetting(h.db, 'project', projectId, 'modules.code_review.enabled', true);
    await upsertSetting(h.db, 'project', projectId, 'review.auto_run', true);
    expect(await isModuleEnabled(h.db, 'code_review', orgId, projectId)).toBe(true);
    await storeDelivery(orgId, 'd-on', 'pull_request', prPayload('sha-on'));
    await handlers['github.process_delivery']!(fakeJob(newId(), 'd-on'), h.db, log);
    const outbox = await h.db.selectFrom('outbox').select('id').where('topic', '=', 'review.code_run').execute();
    expect(outbox).toHaveLength(1);
  });

  it('review.code_run handler runs the shared engine (fake provider, no network)', async () => {
    const { orgId, projectId, repoId } = await seedProject('wk-run@x.io');
    await upsertSetting(h.db, 'project', projectId, 'modules.code_review.enabled', true);
    await upsertSetting(h.db, 'project', projectId, 'review.auto_run', true);
    setReviewProviderResolver(async () => new StubProvider(() => ({ findings: [] })));
    setDiffProvider(async () => ({ hunks: [], snapshot: [{ path: 'a.ts', lines: ['x'] }] }));

    await handlers['review.code_run']!(
      reviewJob(newId(), { organization_id: orgId, project_id: projectId, repository_id: repoId, repository_full_name: 'org/rich', pr_number: 9, head_sha: 'sha-run', draft: false }),
      h.db,
      log,
    );
    const run = await h.db.selectFrom('review_runs').select(['status', 'kind']).where('organization_id', '=', orgId).executeTakeFirstOrThrow();
    expect(run.kind).toBe('code');
    expect(run.status).toBe('completed');
  });

  it('review.code_run with no provider/module disabled => skipped, no run row', async () => {
    const { orgId, projectId, repoId } = await seedProject('wk-skip@x.io');
    // module enabled but auto_run OFF => engine short-circuits (skipped)
    await upsertSetting(h.db, 'project', projectId, 'modules.code_review.enabled', true);
    setReviewProviderResolver(async () => new StubProvider(() => ({ findings: [] })));
    setDiffProvider(async () => ({ hunks: [], snapshot: [] }));
    await handlers['review.code_run']!(
      reviewJob(newId(), { organization_id: orgId, project_id: projectId, repository_id: repoId, repository_full_name: 'org/rich', pr_number: 3, head_sha: 's', draft: false }),
      h.db,
      log,
    );
    const runs = await h.db.selectFrom('review_runs').select('id').where('organization_id', '=', orgId).execute();
    expect(runs).toHaveLength(0); // auto_run default OFF => skipped
  });
});

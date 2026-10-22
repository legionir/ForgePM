import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import IORedis from 'ioredis';
import { Worker } from 'bullmq';
import {
  createCipher,
  setActiveCipher,
  newId,
  getEffective,
  type Logger,
} from '@forgepm/core';
import { createLogger } from '@forgepm/core';
import { handlers } from '../../apps/worker/src/handlers';
import { createHarness, type Harness } from './harness';
import { seedOrg } from './seed';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const log: Logger = createLogger('fatal');
let h: Harness;

beforeAll(async () => {
  setActiveCipher(createCipher(Buffer.alloc(32, 7)));
  h = await createHarness();
});
afterAll(async () => { await h.cleanup(); });
beforeEach(async () => { await h.reset(); });

function fakeJob(jobId: string, deliveryId: string): never {
  return { id: jobId, name: 'github.process_delivery', data: { job_id: jobId, payload: { delivery_id: deliveryId } } } as never;
}

async function seedProject(email: string): Promise<{ orgId: string; projectId: string }> {
  const seed = await seedOrg(h.db, { email, password: 'hunter22x', projectKey: 'WOK' });
  return { orgId: seed.organizationId, projectId: seed.projectId };
}

async function storeDelivery(orgId: string, id: string, event: string, payload: unknown): Promise<void> {
  await h.db
    .insertInto('webhook_deliveries')
    .values({ id: newId(), organization_id: orgId, delivery_id: id, event, payload: JSON.parse(JSON.stringify(payload)) })
    .execute();
}

describe('worker github.process_delivery (plan §9 acceptance, e2e)', () => {
  it('pull_request delivery links items by keys (branch + title + body)', async () => {
    const { orgId, projectId } = await seedProject('wk-pr@x.io');
    const itemA = newId();
    const itemB = newId();
    // two items numbered 1 and 2 (FPM-like via project key WH -> WOK-1/WOK-2)
    const st = await h.db.selectFrom('workflow_states').select('id').where('project_id', '=', projectId).where('category', '=', 'unstarted').executeTakeFirst();
    // ensure at least a backlog state exists (seed creates none) — create states via API not available here; insert manually
    await h.db.deleteFrom('work_items').execute();
    const backlog = st?.id ?? (await h.db.insertInto('workflow_states').values({ id: newId(), organization_id: orgId, project_id: projectId, name: 'Todo', category: 'unstarted' }).returning('id').executeTakeFirst()).id;
    const todoState = await h.db.selectFrom('workflow_states').select('id').where('project_id', '=', projectId).executeTakeFirstOrThrow();
    void backlog;
    await h.db.insertInto('work_items').values([
      { id: itemA, organization_id: orgId, project_id: projectId, number: 1, type: 'task', title: 'form', state_id: todoState.id },
      { id: itemB, organization_id: orgId, project_id: projectId, number: 2, type: 'task', title: 'backend', state_id: todoState.id },
    ]).execute();
    // connect repo to project
    const repoId = newId();
    await h.db.insertInto('repositories').values({ id: repoId, organization_id: orgId, provider: 'github', external_id: 'r-1', full_name: 'org/repo' }).execute();
    await h.db.insertInto('project_repositories').values({ project_id: projectId, repository_id: repoId, organization_id: orgId }).execute();

    await storeDelivery(orgId, 'del-pr-1', 'pull_request', {
      action: 'opened',
      repository: { id: 'r-1', full_name: 'org/repo' },
      pull_request: { id: 'pr-9', number: 9, title: 'adds WOK-2 and mentions WOK-1', state: 'open', draft: false, body: 'closes WOK-1 on later merge', head: { ref: 'feat/WOK-1', sha: 'deadbeef' }, user: { login: 'dev' } },
    });

    await handlers['github.process_delivery']!(fakeJob(newId(), 'del-pr-1'), h.db, log);

    const links = await h.db.selectFrom('work_item_external_links').select('work_item_id').where('kind', '=', 'pr').where('external_id', '=', 'pr-9').execute();
    expect(links.length).toBe(2);
    const delivered = await h.db.selectFrom('webhook_deliveries').select('status').where('delivery_id', '=', 'del-pr-1').executeTakeFirstOrThrow();
    expect(delivered.status).toBe('done');
  });

  it('re-running the same delivery is a no-op (at-least-once idempotent)', async () => {
    const { orgId, projectId } = await seedProject('wk-idem@x.io');
    const st = await h.db.insertInto('workflow_states').values({ id: newId(), organization_id: orgId, project_id: projectId, name: 'Todo', category: 'unstarted' }).returning('id').executeTakeFirstOrThrow();
    const itemId = newId();
    await h.db.insertInto('work_items').values({ id: itemId, organization_id: orgId, project_id: projectId, number: 1, type: 'task', title: 'x', state_id: st.id }).execute();
    const repoId = newId();
    await h.db.insertInto('repositories').values({ id: repoId, organization_id: orgId, provider: 'github', external_id: 'r-2', full_name: 'o/r' }).execute();
    await h.db.insertInto('project_repositories').values({ project_id: projectId, repository_id: repoId, organization_id: orgId }).execute();
    await storeDelivery(orgId, 'del-idem', 'pull_request', { action: 'opened', repository: { id: 'r-2', full_name: 'o/r' }, pull_request: { id: 'pr-1', number: 1, title: 'ref WOK-1', state: 'open', draft: false, head: { ref: 'feat/WOK-1', sha: 'a' } } });
    await handlers['github.process_delivery']!(fakeJob(newId(), 'del-idem'), h.db, log);
    await handlers['github.process_delivery']!(fakeJob(newId(), 'del-idem'), h.db, log); // second: skipped (status done)
    const prs = await h.db.selectFrom('pull_requests').selectAll().where('external_id', '=', 'pr-1').execute();
    expect(prs.length).toBe(1);
    const links = await h.db.selectFrom('work_item_external_links').selectAll().where('external_id', '=', 'pr-1').execute();
    expect(links.length).toBe(1);
  });

  it('issues delivery imports when project mode=import', async () => {
    const { orgId, projectId } = await seedProject('wk-issue@x.io');
    await h.db.insertInto('workflow_states').values([
      { id: newId(), organization_id: orgId, project_id: projectId, name: 'Todo', category: 'unstarted' },
      { id: newId(), organization_id: orgId, project_id: projectId, name: 'Done', category: 'completed' },
    ]).execute();
    const repoId = newId();
    await h.db.insertInto('repositories').values({ id: repoId, organization_id: orgId, provider: 'github', external_id: 'r-3', full_name: 'o/i' }).execute();
    await h.db.insertInto('project_repositories').values({ project_id: projectId, repository_id: repoId, organization_id: orgId }).execute();
    // set project import mode
    const { upsertSetting } = await import('@forgepm/core');
    await upsertSetting(h.db, 'project', projectId, 'github.issue_sync_mode', 'import');
    expect((await getEffective(h.db, 'github.issue_sync_mode', orgId, projectId))?.value).toBe('import');

    await storeDelivery(orgId, 'del-issue', 'issues', { action: 'opened', repository: { id: 'r-3', full_name: 'o/i' }, issue: { id: 'iss-1', number: 77, title: 'spike', body: 'details', state: 'open', labels: [{ name: 'bug' }], updated_at: '2026-01-01T00:00:00Z' } });
    await handlers['github.process_delivery']!(fakeJob(newId(), 'del-issue'), h.db, log);

    const items = await h.db.selectFrom('work_items').selectAll().where('project_id', '=', projectId).execute();
    expect(items.length).toBe(1);
    expect(items[0].title).toBe('spike');
    const link = await h.db.selectFrom('external_issue_links').selectAll().where('issue_number', '=', 77).execute();
    expect(link.length).toBe(1);
  });

  it('release delivery records a release row', async () => {
    const { orgId } = await seedProject('wk-rel@x.io');
    await storeDelivery(orgId, 'del-rel', 'release', { action: 'published', repository: { id: 'r-9', full_name: 'o/r' }, release: { id: 'rel-1', tag_name: 'v2.0.0', published_at: '2026-02-02T00:00:00Z', body: 'notes here' } });
    await handlers['github.process_delivery']!(fakeJob(newId(), 'del-rel'), h.db, log);
    const rel = await h.db.selectFrom('releases').selectAll().where('tag', '=', 'v2.0.0').execute();
    expect(rel.length).toBe(1);
  });

  it('installation and installation_repositories deliveries register repositories idempotently and never delete', async () => {
    const { orgId } = await seedProject('wk-inst@x.io');
    await storeDelivery(orgId, 'del-inst', 'installation', { action: 'created', installation: { id: 321 }, repositories: [{ id: 11, full_name: 'o/a' }, { id: 12, full_name: 'o/b' }] });
    await handlers['github.process_delivery']!(fakeJob(newId(), 'del-inst'), h.db, log);
    await storeDelivery(orgId, 'del-inst-repos', 'installation_repositories', { action: 'added', installation: { id: 321 }, repositories_added: [{ id: 12, full_name: 'o/b-renamed' }, { id: 13, full_name: 'o/c' }], repositories_removed: [{ id: 11, full_name: 'o/a' }] });
    await handlers['github.process_delivery']!(fakeJob(newId(), 'del-inst-repos'), h.db, log);

    const repos = await h.db.selectFrom('repositories').select(['external_id', 'full_name', 'installation_id']).orderBy('external_id').execute();
    expect(repos.map((r) => r.external_id)).toEqual(['11', '12', '13']); // removal reported, not deleted
    expect(repos.find((r) => r.external_id === '12')?.full_name).toBe('o/b-renamed');
    expect(repos.every((r) => r.installation_id === '321')).toBe(true);
    const done = await h.db.selectFrom('webhook_deliveries').select('status').where('delivery_id', 'in', ['del-inst', 'del-inst-repos']).execute();
    expect(done.map((d) => d.status)).toEqual(['done', 'done']);
  });

  it('jobs run via the real outbox->dispatcher->worker path', async () => {
    const { orgId, projectId } = await seedProject('wk-e2e@x.io');
    const st = await h.db.insertInto('workflow_states').values({ id: newId(), organization_id: orgId, project_id: projectId, name: 'Todo', category: 'unstarted' }).returning('id').executeTakeFirstOrThrow();
    const itemId = newId();
    await h.db.insertInto('work_items').values({ id: itemId, organization_id: orgId, project_id: projectId, number: 1, type: 'task', title: 'linked via worker', state_id: st.id }).execute();
    const repoId = newId();
    await h.db.insertInto('repositories').values({ id: repoId, organization_id: orgId, provider: 'github', external_id: 'r-e', full_name: 'o/e' }).execute();
    await h.db.insertInto('project_repositories').values({ project_id: projectId, repository_id: repoId, organization_id: orgId }).execute();
    // insert delivery + enqueue through the same helper the webhook route uses
    await storeDelivery(orgId, 'del-e2e', 'pull_request', { action: 'opened', repository: { id: 'r-e', full_name: 'o/e' }, pull_request: { id: 'pr-e', number: 5, title: 'fixes WOK-1', state: 'open', draft: false, head: { ref: 'feat/x', sha: 'z' }, merged: true } });
    const { appendOutbox } = await import('@forgepm/core');
    await appendOutbox(h.db, { organization_id: orgId, topic: 'github.process_delivery', payload: { delivery_id: 'del-e2e' } });

    // dispatcher tick moves outbox → BullMQ (the same code path the worker uses)
    const { OutboxDispatcher } = await import('../../apps/worker/src/dispatcher');
    const dispatcher = new OutboxDispatcher(h.db, h.queue, log, 10, 50);
    await dispatcher.tick();

    const workerConn = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    const worker = new Worker(h.queueName, async (job) => { const hd = handlers[job.name]; if (hd) await hd(job, h.db, log); }, { connection: workerConn });
    await new Promise<void>((resolve, reject) => {
      worker.on('completed', async () => {
        const done = await h.db.selectFrom('webhook_deliveries').select('status').where('delivery_id', '=', 'del-e2e').executeTakeFirstOrThrow();
        if (done.status === 'done') resolve();
      });
      worker.on('failed', (_j, err) => reject(err));
      setTimeout(() => reject(new Error('timeout')), 15_000);
    });
    await worker.close();
    workerConn.disconnect();
    const links = await h.db.selectFrom('work_item_external_links').selectAll().where('external_id', '=', 'pr-e').execute();
    expect(links.length).toBe(1);
  });
});


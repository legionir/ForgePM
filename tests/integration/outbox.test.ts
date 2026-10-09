import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { QUEUES, createLogger, newId, unitOfWork, type Db, type Logger } from '@forgepm/core';
import { OutboxDispatcher } from '../../apps/worker/src/dispatcher';
import { JobSweeper } from '../../apps/worker/src/sweeper';
import { handlers, pingEffects, resetPingEffects } from '../../apps/worker/src/handlers';
import { createHarness, type Harness } from './harness';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const log = createLogger('fatal');
let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  resetPingEffects();
  await h.cleanup();
});
beforeEach(async () => {
  resetPingEffects();
  await h.reset();
});

/**
 * Run a real worker on the default queue until `expectN` jobs have been
 * processed through the domain handler, then close. Uses a DEDICATED ioredis
 * connection: a BullMQ Worker blocks its connection (BRPOPLPUSH), so it must
 * not share the queue producer's connection.
 */
function runWorkerUntilProcessed(
  queueName: string,
  db: Db,
  logger: Logger,
  expectN: number,
  timeoutMs = 10_000,
): Promise<{ processed: number; close: () => Promise<void> }> {
  const workerConn = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  let processed = 0;
  let done!: () => void;
  let fail!: (e: Error) => void;
  const finished = new Promise<void>((res, rej) => {
    done = res;
    fail = rej;
  });

  const worker = new Worker(
    queueName,
    async (job) => {
      const handler = handlers[job.name];
      if (handler) await handler(job, db, logger);
      processed++;
      if (processed >= expectN) done();
    },
    { connection: workerConn },
  );
  worker.on('failed', (_job, err) => fail(err ?? new Error('job failed')));

  const timer = setTimeout(() => fail(new Error('worker timeout')), timeoutMs);
  return finished
    .then(() => ({ processed, close: async () => { clearTimeout(timer); await worker.close(); workerConn.disconnect(); } }))
    .catch(async (e) => {
      clearTimeout(timer);
      await worker.close();
      workerConn.disconnect();
      throw e;
    });
}

describe('outbox dispatcher: exactly one effect per row (plan §4.6)', () => {
  it('dispatches one outbox row and applies the job effect exactly once', async () => {
    const effectKey = newId();
    await unitOfWork(h.db, (ctx) => ctx.enqueue('system.ping', { effect_key: effectKey }));

    const dispatcher = new OutboxDispatcher(h.db, h.queue, log, 10, 50);
    await dispatcher.tick();

    const outbox = await h.db.selectFrom('outbox').selectAll().execute();
    expect(outbox[0]!.dispatched_at).not.toBeNull();
    const jobs = await h.db.selectFrom('jobs').selectAll().execute();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe('queued');

    const w = await runWorkerUntilProcessed(h.queueName, h.db, log, 1);
    await w.close();

    expect(pingEffects.get(effectKey)).toBe(1);
    const done = await h.db.selectFrom('jobs').select('status').execute();
    expect(done[0]!.status).toBe('succeeded');
  });

  it('is idempotent when the same effect_key is delivered twice (at-least-once)', async () => {
    const jobId = newId();
    const effectKey = newId();
    const fake = { id: 'bull-1', name: 'system.ping', data: { job_id: jobId, payload: { effect_key: effectKey } } } as never;
    await handlers['system.ping']!(fake, h.db, log);
    await handlers['system.ping']!(fake, h.db, log);
    expect(pingEffects.get(effectKey)).toBe(1);
  });
});

describe('outbox dispatcher crash recovery (plan §4.6)', () => {
  it('recovers a crash after claim+commit but before enqueue, with no duplicate', async () => {
    const effectKey = newId();
    await unitOfWork(h.db, (ctx) => ctx.enqueue('system.ping', { effect_key: effectKey }));

    // BullMQ add throws → dispatcher aborts before stamping dispatched_at.
    const boom = { add: async () => { throw new Error('simulated crash'); } } as never;
    const dispatcher = new OutboxDispatcher(h.db, boom, log, 10, 50);
    await expect(dispatcher.tick()).rejects.toThrowError(/simulated crash/);

    const outbox = await h.db.selectFrom('outbox').selectAll().execute();
    expect(outbox[0]!.dispatched_at).toBeNull();
    const jobs = await h.db.selectFrom('jobs').selectAll().execute();
    expect(jobs).toHaveLength(1);

    // Restart: healthy dispatcher re-claims, ON CONFLICT keeps ONE job row,
    // re-enqueues the SAME jobId, stamps dispatched_at.
    const dispatcher2 = new OutboxDispatcher(h.db, h.queue, log, 10, 50);
    await dispatcher2.tick();
    expect(await h.db.selectFrom('jobs').selectAll().execute()).toHaveLength(1);
    expect((await h.db.selectFrom('outbox').selectAll().execute())[0]!.dispatched_at).not.toBeNull();

    const w = await runWorkerUntilProcessed(h.queueName, h.db, log, 1);
    await w.close();
    expect(pingEffects.get(effectKey)).toBe(1);
  });
});

describe('job sweeper recovery (plan §3b-3)', () => {
  it('re-enqueues a stuck queued job and it runs exactly once', async () => {
    const jobId = newId();
    const effectKey = newId();
    await h.db
      .insertInto('jobs')
      .values({
        id: jobId,
        queue: QUEUES.default,
        type: 'system.ping',
        status: 'queued',
        payload: { effect_key: effectKey } as never,
        created_at: new Date(Date.now() - 20 * 60_000),
      })
      .execute();

    const sweeper = new JobSweeper(h.db, h.queue, log, 10 * 60_000, 15 * 60_000, 1000);
    expect((await sweeper.tick()).requeued).toBe(1);

    const w = await runWorkerUntilProcessed(h.queueName, h.db, log, 1);
    await w.close();
    expect(pingEffects.get(effectKey)).toBe(1);
  });

  it('marks a heartbeat-stalled running job as failed', async () => {
    const jobId = newId();
    await h.db
      .insertInto('jobs')
      .values({
        id: jobId,
        queue: QUEUES.default,
        type: 'system.ping',
        status: 'running',
        payload: {} as never,
        heartbeat_at: new Date(Date.now() - 30 * 60_000),
        started_at: new Date(Date.now() - 30 * 60_000),
      })
      .execute();

    const sweeper = new JobSweeper(h.db, h.queue, log, 10 * 60_000, 15 * 60_000, 1000);
    expect((await sweeper.tick()).failed).toBe(1);
    const job = await h.db.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(job.status).toBe('failed');
  });
});

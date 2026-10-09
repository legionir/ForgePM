import { Worker, type Job, type ConnectionOptions } from 'bullmq';
import { QUEUES, type Db, type Logger } from '@forgepm/core';

/**
 * A deterministic, inspectable effect counter keyed by the DB job id.
 * Phase 0's "exactly one effect" acceptance test (plan §4.6) reads this.
 * Real domain phases replace the counter with the actual side effect, still
 * guarded by the `jobs` row status so at-least-once delivery applies it once.
 */
export const pingEffects = new Map<string, number>();

export function effectCount(jobId: string): number {
  return pingEffects.get(jobId) ?? 0;
}

export function resetPingEffects(): void {
  pingEffects.clear();
}

/**
 * system.ping — Phase 0 sample job executed via the outbox path (plan §4.6).
 * Idempotent: if the DB job row already succeeded, the effect is skipped.
 */
export type JobHandler = (job: Job, db: Db, log: Logger) => Promise<void>;

export const handlers: Record<string, JobHandler> = {
  'system.ping': async (job, db, log) => {
    const data = job.data as { job_id?: string; payload?: { effect_key?: string } };
    const jobId = data.job_id ?? String(job.id);
    const effectKey = data.payload?.effect_key ?? jobId;

    // Idempotency guard: never apply the same effect_key twice, even if a
    // different job row (redelivery/re-enqueue) carries it. Keyed in a set so
    // at-least-once delivery from the outbox path yields exactly one effect.
    if (pingEffects.get(effectKey) !== undefined) {
      log.info({ jobId, effectKey }, 'system.ping effect already applied; skipping');
      await db.updateTable('jobs').set({ status: 'succeeded', finished_at: new Date() }).where('id', '=', jobId).execute();
      return;
    }

    await db
      .updateTable('jobs')
      .set({ status: 'running', started_at: new Date(), heartbeat_at: new Date() })
      .where('id', '=', jobId)
      .execute();

    pingEffects.set(effectKey, (pingEffects.get(effectKey) ?? 0) + 1);
    log.info({ jobId, effectKey }, 'system.ping effect applied');

    await db.updateTable('jobs').set({ status: 'succeeded', finished_at: new Date() }).where('id', '=', jobId).execute();
  },
};

export function createDefaultWorker(connection: ConnectionOptions, db: Db, log: Logger): Worker {
  return new Worker(
    QUEUES.default,
    async (job) => {
      const handler = handlers[job.name];
      if (!handler) {
        log.error({ jobName: job.name }, 'no handler for job type');
        return;
      }
      await handler(job, db, log);
    },
    { connection },
  );
}

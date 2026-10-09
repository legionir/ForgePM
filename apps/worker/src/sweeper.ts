import { sql } from 'kysely';
import { Queue } from 'bullmq';
import type { Db, Logger } from '@forgepm/core';

/**
 * Job sweeper (plan §3b-3):
 *  - `queued` jobs older than staleQueuedMs → re-enqueue (dispatcher may have
 *    crashed between the DB transaction and the BullMQ add).
 *  - `running` jobs whose heartbeat_at is older than staleRunningMs → mark
 *    `failed` so they can be retried from the panel / by policy.
 * Re-enqueue uses the DB job id as the BullMQ jobId, so a job that actually
 * was enqueued is not duplicated by this path.
 */
export class JobSweeper {
  private timer?: NodeJS.Timeout;

  constructor(
    private db: Db,
    private queue: Queue,
    private log: Logger,
    private staleQueuedMs = 10 * 60 * 1000,
    private staleRunningMs = 15 * 60 * 1000,
    private intervalMs = 5 * 60 * 1000,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.log.error({ err }, 'sweeper tick failed'));
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One sweep; exposed for tests. */
  async tick(): Promise<{ requeued: number; failed: number }> {
    let requeued = 0;
    let failed = 0;

    const staleQueued = await sql<{ id: string; type: string; payload: unknown }>`
      SELECT id, type, payload
      FROM jobs
      WHERE status = 'queued'
        AND created_at < now() - (${this.staleQueuedMs}::double precision * interval '1 millisecond')
      LIMIT 100
    `.execute(this.db);

    for (const row of staleQueued.rows) {
      await this.queue.add(row.type, { job_id: row.id, payload: row.payload }, {
        jobId: row.id,
        removeOnComplete: { age: 60 * 60 * 24, count: 10000 },
        removeOnFail: false,
      });
      requeued++;
    }

    const staleRunning = await sql<{ id: string }>`
      UPDATE jobs
      SET status = 'failed',
          error = COALESCE(error, '') || 'sweeper: heartbeat lost',
          finished_at = now(),
          updated_at = now()
      WHERE id IN (
        SELECT id FROM jobs
        WHERE status = 'running'
          AND COALESCE(heartbeat_at, started_at) < now() - (${this.staleRunningMs}::double precision * interval '1 millisecond')
        LIMIT 100
      )
      RETURNING id
    `.execute(this.db);
    failed = staleRunning.rows.length;

    if (requeued || failed) this.log.warn({ requeued, failed }, 'sweeper recovered jobs');
    return { requeued, failed };
  }
}

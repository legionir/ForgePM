import { sql } from 'kysely';
import { Queue } from 'bullmq';
import { newId, QUEUES, toJsonb, type Db, type Logger } from '@forgepm/core';

export interface DispatchResult {
  dispatched: number;
}

interface Claimed {
  outbox_id: string;
  job_id: string;
  topic: string;
  payload: unknown;
}

/**
 * Outbox dispatcher (plan §3b-3):
 *  1. one transaction: claim undispatched rows with
 *     `SELECT ... FOR UPDATE SKIP LOCKED` and insert a `jobs` registry row
 *     (status `queued`) per claimed row — both commit atomically.
 *  2. after commit: enqueue to BullMQ using the job id as BullMQ jobId, so a
 *     crash between commit and enqueue cannot create duplicates (the sweeper
 *     re-enqueues `queued` jobs with the same jobId; BullMQ dedupes).
 *  3. stamp `dispatched_at` after a successful enqueue.
 *
 * Delivery is at-least-once and every handler is idempotent.
 */
export class OutboxDispatcher {
  private timer?: NodeJS.Timeout;

  constructor(
    private db: Db,
    private queue: Queue,
    private log: Logger,
    private batchSize = 50,
    private intervalMs = 500,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.log.error({ err }, 'outbox dispatch tick failed'));
    }, this.intervalMs);
    void this.tick().catch((err) => this.log.error({ err }, 'outbox dispatch tick failed'));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One dispatch pass; exposed for tests. */
  async tick(): Promise<DispatchResult> {
    const claimed: Claimed[] = [];

    await this.db.transaction().execute(async (tx) => {
      const res = await sql<{ id: string; topic: string; payload: unknown; organization_id: string | null }>`
        SELECT id, topic, payload, organization_id
        FROM outbox
        WHERE dispatched_at IS NULL
        ORDER BY created_at
        LIMIT ${this.batchSize}
        FOR UPDATE SKIP LOCKED
      `.execute(tx);

      for (const row of res.rows) {
        const jobId = newId();
        // ON CONFLICT (outbox_id) DO NOTHING: if a previous crashed attempt
        // already created the job registry row, reuse it — never a second job.
        const inserted = await tx
          .insertInto('jobs')
          .values({
            id: jobId,
            organization_id: row.organization_id,
            queue: QUEUES.default,
            type: row.topic,
            status: 'queued',
            payload: toJsonb(row.payload) as never,
            outbox_id: row.id,
          })
          .onConflict((oc) => oc.column('outbox_id').doNothing())
          .returning('id')
          .executeTakeFirst();

        let finalId = inserted?.id;
        if (!finalId) {
          const existing = await tx
            .selectFrom('jobs')
            .select('id')
            .where('outbox_id', '=', row.id)
            .executeTakeFirst();
          if (!existing) throw new Error(`outbox ${row.id}: job row vanished`);
          finalId = existing.id;
        }
        claimed.push({ outbox_id: row.id, job_id: finalId, topic: row.topic, payload: row.payload });
      }
    });

    for (const c of claimed) {
      await this.queue.add(c.topic, { job_id: c.job_id, payload: c.payload }, {
        jobId: c.job_id, // dedupe: re-adding the same jobId is a no-op
        removeOnComplete: { age: 60 * 60 * 24, count: 10000 },
        removeOnFail: false,
      });
      await this.db
        .updateTable('outbox')
        .set({ dispatched_at: new Date() })
        .where('id', '=', c.outbox_id)
        .execute();
    }

    if (claimed.length > 0) this.log.info({ dispatched: claimed.length }, 'outbox rows dispatched');
    return { dispatched: claimed.length };
  }
}

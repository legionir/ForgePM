import { Worker, type Job, type ConnectionOptions } from 'bullmq';
import {
  QUEUES,
  SYSTEM_ACTOR_ID,
  recordAudit,
  applyPullRequestEvent,
  normalizePullRequestPayload,
  normalizeIssuePayload,
  importIssueEvent,
  recordRelease,
  getEffective,
  deliveryRow,
  markDeliveryDone,
  runCodeReviewForPr,
  isModuleEnabled,
  newId,
  toJsonb,
  type Db,
  type Logger,
} from '@forgepm/core';

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

  /**
   * github.process_delivery (plan §9): apply a stored webhook delivery idempotently.
   * at-least-once BullMQ delivery + a status guard means one effect per delivery
   * even if the dispatcher re-enqueues after a crash.
   */
  'github.process_delivery': async (job, db, log) => {
    const data = job.data as { job_id?: string; payload?: { delivery_id?: string } };
    const jobId = data.job_id ?? String(job.id);
    const deliveryId = data.payload?.delivery_id;
    if (!deliveryId) {
      await db.updateTable('jobs').set({ status: 'failed', error: 'no delivery_id', finished_at: new Date() }).where('id', '=', jobId).execute();
      return;
    }
    const row = await deliveryRow(db, deliveryId);
    if (!row) {
      await db.updateTable('jobs').set({ status: 'succeeded', finished_at: new Date() }).where('id', '=', jobId).execute();
      return;
    }
    if (row.status === 'done') {
      log.info({ deliveryId }, 'delivery already processed; skipping');
      await db.updateTable('jobs').set({ status: 'succeeded', finished_at: new Date() }).where('id', '=', jobId).execute();
      return;
    }
    await db.updateTable('jobs').set({ status: 'running', started_at: new Date(), heartbeat_at: new Date() }).where('id', '=', jobId).execute();
    await db.updateTable('webhook_deliveries').set({ status: 'processing' } as never).where('delivery_id', '=', deliveryId).execute();

    const payload = (row.payload ?? {}) as Record<string, unknown>;
    let summary: Record<string, unknown> = { delivery_id: deliveryId, event: row.event };

    if (row.event === 'pull_request') {
      const ev = normalizePullRequestPayload(payload);
      if (ev) {
        const auto = async (projectId: string): Promise<boolean> =>
          (await getEffective(db, 'github.auto_transition_on_merge', row.organization_id, projectId))?.value === true;
        const out = await applyPullRequestEvent(db, row.organization_id, ev, auto);
        summary = { ...summary, ...out };
        // Code Review auto-run trigger (plan §10.6.A.1). Enqueue one review job
        // per connected project that has code_review enabled + review.auto_run;
        // the reviewer job re-checks gates at run time (no import of the api).
        if (['opened', 'synchronize', 'ready_for_review'].includes(ev.action)) {
          const repo = await db
            .selectFrom('repositories')
            .select(['id', 'full_name'])
            .where('provider', '=', 'github')
            .where('external_id', '=', ev.repository_external_id)
            .executeTakeFirst();
          if (repo) {
            const projectIds = (await db
              .selectFrom('project_repositories')
              .select('project_id')
              .where('repository_id', '=', repo.id)
              .where('organization_id', '=', row.organization_id)
              .execute()).map((r) => r.project_id);
            let enq = 0;
            for (const projectId of projectIds) {
              if (!(await isCodeReviewAutoEnabled(db, row.organization_id, projectId))) continue;
              await db
                .insertInto('outbox')
                .values({
                  id: newId(),
                  organization_id: row.organization_id,
                  topic: 'review.code_run',
                  payload: toJsonb({
                    organization_id: row.organization_id,
                    project_id: projectId,
                    repository_id: repo.id,
                    repository_full_name: repo.full_name,
                    pr_number: ev.number,
                    head_sha: ev.head_sha,
                    draft: ev.draft,
                  }) as never,
                })
                .execute();
              enq++;
            }
            if (enq > 0) summary.review_enqueued = enq;
          }
        }
      }
    } else if (row.event === 'issues') {
      const norm = normalizeIssuePayload(payload);
      if (norm) {
        // import into every project connected to the repository.
        const repo = await db
          .selectFrom('repositories')
          .select('id')
          .where('provider', '=', 'github')
          .where('external_id', '=', norm.repository_external_id)
          .executeTakeFirst();
        if (repo) {
          const projectIds = (await db.selectFrom('project_repositories').select('project_id').where('repository_id', '=', repo.id).execute()).map((r) => r.project_id);
          const actions: string[] = [];
          for (const pid of projectIds) {
            actions.push(await importIssueEvent(db, row.organization_id, pid, norm.issue, SYSTEM_ACTOR_ID));
          }
          summary = { ...summary, actions };
        }
      }
    } else if (row.event === 'release') {
      const repo = (payload.repository ?? {}) as Record<string, unknown>;
      const rel = (payload.release ?? {}) as Record<string, unknown>;
      const tag = (rel.tag_name ?? rel.tag) as string;
      if (repo.id && tag) {
        const out = await recordRelease(
          db,
          row.organization_id,
          { external_id: String(repo.id), full_name: (repo.full_name as string) ?? '' },
          tag,
          (rel.published_at as string) ?? null,
          (rel.body as string) ?? null,
        );
        summary = { ...summary, ...out };
      }
    }

    await db.transaction().execute(async (tx) => {
      await recordAudit(tx, {
        organization_id: row.organization_id,
        actor_type: 'system',
        actor_id: SYSTEM_ACTOR_ID,
        action: 'github.process_delivery',
        resource_type: 'webhook_delivery',
        resource_id: jobId,
        summary,
        request_id: null,
      });
    });
    await markDeliveryDone(db, deliveryId);
    await db.updateTable('jobs').set({ status: 'succeeded', finished_at: new Date() }).where('id', '=', jobId).execute();
  },

  /**
   * review.code_run (plan §10.6.A.1): a webhook-triggered Code Review. Runs the
   * SHARED core engine (runCodeReviewForPr), which re-checks the module gate,
   * review.auto_run and draft skip at run time — so toggling the setting after
   * enqueue is honoured. Idempotent per job row.
   */
  'review.code_run': async (job, db, log) => {
    const data = job.data as { job_id?: string; payload?: Record<string, unknown> };
    const jobId = data.job_id ?? String(job.id);
    const p = data.payload ?? {};
    await db.updateTable('jobs').set({ status: 'running', started_at: new Date(), heartbeat_at: new Date() }).where('id', '=', jobId).execute();
    const out = await runCodeReviewForPr(db, {
      organizationId: String(p.organization_id ?? ''),
      projectId: String(p.project_id ?? ''),
      repositoryId: String(p.repository_id ?? ''),
      repositoryFullName: String(p.repository_full_name ?? ''),
      prNumber: Number(p.pr_number ?? 0),
      headSha: (p.head_sha as string) ?? null,
      draft: !!p.draft,
    });
    log.info({ jobId, out: 'run_id' in out ? out.run_id : ('skipped' in out ? out.skipped : '?') }, 'review.code_run done');
    await db.updateTable('jobs').set({ status: 'succeeded', finished_at: new Date() }).where('id', '=', jobId).execute();
  },
};

/** code_review enabled + review.auto_run at the project scope. */
async function isCodeReviewAutoEnabled(db: Db, orgId: string, projectId: string): Promise<boolean> {
  if (!(await isModuleEnabled(db, 'code_review', orgId, projectId))) return false;
  const auto = await getEffective(db, 'review.auto_run', orgId, projectId);
  return auto?.value === true;
}


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

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  listQuerySchema,
  encodeCursor,
  decodeCursor,
  AppError,
} from '@forgepm/shared';
import { pingDb, recordAudit, unitOfWork, newId } from '@forgepm/core';
import type { AppDeps } from '../../app/app';
import { guard, requireActor } from '../../app/guards';

/**
 * System panel surface (plan §5.11 Jobs/System Health, §11 "Backups/Storage/
 * System Health کامل", docs/API_CONTRACTS.md "System" row). Contract-promised
 * endpoints the phase-1..6 backend-first passes (D-013) left for the panel:
 *   GET  /api/v1/jobs              cursor-paginated job registry (org-scoped)
 *   POST /api/v1/jobs/:id/retry    re-queue failed/dead jobs (sweeper enqueues)
 *   GET  /api/v1/system/health     db + redis + per-module enabled flags
 *   POST /api/v1/system/backup     run scripts/backup.sh (admin only), audited
 */
const execFileAsync = promisify(execFile);

const jobDto = z.object({
  id: z.string(),
  queue: z.string(),
  type: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'dead']),
  attempts: z.number(),
  error: z.string().nullable(),
  heartbeat_at: z.string().nullable(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  created_at: z.string(),
});

const iso = (v: unknown): string | null => (v ? new Date(v as string | number | Date).toISOString() : null);
const mapJob = (r: {
  id: string; queue: string; type: string; status: string; attempts: number; error: string | null;
  heartbeat_at: Date | null; started_at: Date | null; finished_at: Date | null; created_at: Date;
}) => ({
  id: r.id,
  queue: r.queue,
  type: r.type,
  status: r.status as z.infer<typeof jobDto>['status'],
  attempts: r.attempts,
  error: r.error,
  heartbeat_at: iso(r.heartbeat_at),
  started_at: iso(r.started_at),
  finished_at: iso(r.finished_at),
  created_at: r.created_at.toISOString(),
});

export function registerSystemRoutes(app: FastifyInstance, deps: AppDeps): void {
  const t = app.withTypeProvider<ZodTypeProvider>();
  const db = deps.db;
  const idParams = z.object({ id: z.string().uuid() });

  t.get(
    '/api/v1/jobs',
    {
      schema: {
        querystring: listQuerySchema.extend({ status: z.enum(['queued', 'running', 'succeeded', 'failed', 'dead']).optional() }),
        response: { 200: z.object({ items: z.array(jobDto), next_cursor: z.string().nullable() }) },
      },
      preHandler: guard(db, { action: 'jobs:read' }),
    },
    async (req) => {
      const actor = requireActor(req);
      let q = db
        .selectFrom('jobs')
        .selectAll()
        .where('organization_id', '=', actor.organizationId);
      if (req.query.status) q = q.where('status', '=', req.query.status);
      if (req.query.cursor) {
        const { createdAt, id } = decodeCursor(req.query.cursor);
        q = q.where((eb) =>
          eb.or([eb('created_at', '<', new Date(createdAt)), eb.and([eb('created_at', '=', new Date(createdAt)), eb('id', '<', id)])]),
        );
      }
      const rows = await q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(req.query.limit + 1).execute();
      const hasMore = rows.length > req.query.limit;
      const slice = hasMore ? rows.slice(0, req.query.limit) : rows;
      return {
        items: slice.map(mapJob),
        next_cursor: hasMore ? encodeCursor(slice[slice.length - 1].created_at.toISOString(), slice[slice.length - 1].id) : null,
      };
    },
  );

  // Re-queue is DB-only on purpose (plan §3b-3): the API app holds no BullMQ
  // connection; the worker's sweeper re-enqueues `queued` rows by job id, and
  // BullMQ jobId dedupe makes the handoff at-least-once but never doubling.
  t.post(
    '/api/v1/jobs/:id/retry',
    {
      schema: { params: idParams, response: { 200: z.object({ job: jobDto }) } },
      preHandler: guard(db, { action: 'jobs:read' }),
    },
    async (req) => {
      const actor = requireActor(req);
      const row = await db
        .selectFrom('jobs')
        .selectAll()
        .where('id', '=', req.params.id)
        .where('organization_id', '=', actor.organizationId)
        .executeTakeFirst();
      if (!row) throw new AppError('NOT_FOUND', 'job not found');
      if (row.status !== 'failed' && row.status !== 'dead') {
        throw new AppError('CONFLICT', `job is '${row.status}'; only failed/dead jobs can be retried`);
      }
      const updated = await db
        .updateTable('jobs')
        .set({ status: 'queued', error: null, finished_at: null, heartbeat_at: null, updated_at: new Date() })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await unitOfWork(db, async ({ tx }) => {
        await recordAudit(tx, {
          organization_id: actor.organizationId,
          actor_type: 'user',
          actor_id: actor.id,
          action: 'job.retry',
          resource_type: 'job',
          resource_id: row.id,
          summary: { from: row.status, to: 'queued' },
          request_id: actor.requestId,
        });
      });
      return { job: mapJob(updated) };
    },
  );

  t.get(
    '/api/v1/system/health',
    {
      schema: {
        response: {
          200: z.object({
            database: z.string(),
            redis: z.string(),
            modules: z.array(z.object({ name: z.string(), enabled: z.boolean(), registered: z.boolean() })),
          }),
        },
      },
      preHandler: guard(db, {}),
    },
    async () => {
      let database = 'down';
      try {
        await pingDb(db);
        database = 'ok';
      } catch {
        /* reported below as down */
      }
      const redis = (await deps.redisAvailable()) ? 'ok' : 'down';
      const modules = await Promise.all(
        deps.registry.list().map(async (d) => ({
          name: d.name,
          enabled: await deps.registry.isEnabled(db, d.name, null, null),
          registered: true,
        })),
      );
      return { database, redis, modules };
    },
  );

  // Admin-only manual backup (plan §14 / RUNBOOK). Runs the same
  // scripts/backup.sh the RUNBOOK documents; 202 because the dump itself is
  // synchronous but bounded work — the audit row proves completion.
  t.post(
    '/api/v1/system/backup',
    {
      schema: { response: { 202: z.object({ status: z.literal('backup_complete'), file: z.string() }) } },
      preHandler: guard(db, { action: 'settings:system' }),
    },
    async (_req, reply) => {
      const actor = requireActor(_req);
      // Compose/Dockerfile keep the repo tree in the image, so the runbook's
      // backup script is resolved relative to the process working directory.
      const script = `${process.cwd()}/scripts/backup.sh`;
      let stdout: string;
      try {
        ({ stdout } = await execFileAsync('bash', [script], {
          env: { ...process.env, DATABASE_URL: deps.env.DATABASE_URL, BACKUP_DIR: process.env.BACKUP_DIR ?? './backups' },
          timeout: 120_000,
        }));
      } catch (err) {
        throw new AppError('INTERNAL', `backup failed: ${(err as Error).message}`);
      }
      const file = stdout.trim().split('\n').pop() ?? '';
      await unitOfWork(db, async ({ tx }) => {
        await recordAudit(tx, {
          organization_id: actor.organizationId,
          actor_type: 'user',
          actor_id: actor.id,
          action: 'system.backup',
          resource_type: 'system',
          resource_id: newId(),
          summary: { file },
          request_id: actor.requestId,
        });
      });
      return reply.status(202).send({ status: 'backup_complete', file });
    },
  );
}

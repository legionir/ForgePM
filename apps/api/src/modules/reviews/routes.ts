import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AppError, decodeCursor, encodeCursor } from '@forgepm/shared';
import {
  makeRequireModule,
  recordAudit,
  loadFinding,
  updateFindingStatus,
  createWorkItemFromFinding,
  requestFindingApproval,
  hasApprovedFindingRequest,
  effectiveIssuePolicy,
  type Db,
  type ModuleRegistry,
} from '@forgepm/core';
import { guard, requireActor } from '../../app/guards';
import { assertProjectAccess } from '../projects/access';
import { codeReviewInputSchema, refactorReviewInputSchema } from './service';
import { startCodeReview, startRefactorReview, runReport } from './runners';

/**
 * Reviews REST routes (plan §10, §13). Both optional modules are always
 * registered; every entry point checks its runtime gate first, so with the
 * module off the route answers 503 MODULE_DISABLED and nothing else changes.
 */
export function registerReviewsRoutes(app: FastifyInstance, deps: { db: Db; registry: ModuleRegistry }): void {
  const db = deps.db;
  const requireModule = makeRequireModule(deps.registry, db);
  const t = app.withTypeProvider<ZodTypeProvider>();

  const gate = async (name: 'code_review' | 'refactor_review', organizationId: string, projectId: string | null) => {
    await requireModule(name, { organizationId, projectId });
  };

  const listQuery = z.object({
    project_id: z.string().uuid(),
    kind: z.enum(['code', 'refactor']).optional(),
    status: z.string().max(20).optional(),
    severity: z.string().max(10).optional(),
    finding_status: z.string().max(20).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().optional(),
  });

  // ---- runs ----
  t.get(
    '/api/v1/review/runs',
    { schema: { querystring: listQuery }, preHandler: guard(db, {}) },
    async (req) => {
      const actor = requireActor(req);
      await assertProjectAccess(db, actor, req.query.project_id, 'project:read');
      // list entry points are gated like every other review endpoint (503 when
      // both modules are disabled at this scope — plan §3b-1.3).
      const anyEnabled =
        (await deps.registry.isEnabled(db, 'code_review', actor.organizationId, req.query.project_id)) ||
        (await deps.registry.isEnabled(db, 'refactor_review', actor.organizationId, req.query.project_id));
      if (!anyEnabled) await gate('code_review', actor.organizationId, req.query.project_id);
      const { limit, cursor } = req.query;
      let q = db
        .selectFrom('review_runs')
        .select(['id', 'organization_id', 'project_id', 'repository_id', 'kind', 'target', 'status', 'attempt', 'stats', 'created_at', 'updated_at'])
        .where('organization_id', '=', actor.organizationId)
        .where('project_id', '=', req.query.project_id)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1);
      if (req.query.kind) q = q.where('kind', '=', req.query.kind);
      if (req.query.status) q = q.where('status', '=', req.query.status as never);
      if (cursor) {
        const c = decodeCursor(cursor);
        q = q.where((eb) => eb.or([eb('created_at', '<', new Date(c.createdAt)), eb.and([eb('created_at', '=', new Date(c.createdAt)), eb('id', '<', c.id)])]));
      }
      const rows = await q.execute();
      const page = rows.slice(0, limit);
      const next = rows.length > limit && page.length ? encodeCursor(page[page.length - 1].created_at.toISOString(), page[page.length - 1].id as string) : null;
      return {
        items: page.map((r) => ({
          id: r.id,
          project_id: r.project_id,
          repository_id: r.repository_id,
          kind: r.kind,
          target: r.target,
          status: r.status,
          attempt: r.attempt,
          stats: r.stats,
          created_at: r.created_at.toISOString(),
          updated_at: r.updated_at.toISOString(),
        })),
        next_cursor: next,
      };
    },
  );

  t.get(
    '/api/v1/review/runs/:id',
    { schema: { params: z.object({ id: z.string().uuid() }) }, preHandler: guard(db, {}) },
    async (req) => {
      const actor = requireActor(req);
      const run = await db.selectFrom('review_runs').select(['id', 'project_id', 'kind', 'organization_id']).where('id', '=', req.params.id).executeTakeFirst();
      if (!run || run.organization_id !== actor.organizationId) throw new AppError('NOT_FOUND', 'review run not found');
      await assertProjectAccess(db, actor, run.project_id, 'project:read');
      await gate(run.kind === 'code' ? 'code_review' : 'refactor_review', actor.organizationId, run.project_id);
      return runReport(db, actor.organizationId, req.params.id);
    },
  );

  // ---- start code review (manual from panel / REST) ----
  t.post(
    '/api/v1/review/code-runs',
    { schema: { body: codeReviewInputSchema }, preHandler: guard(db, {}) },
    async (req, reply) => {
      const actor = requireActor(req);
      await gate('code_review', actor.organizationId, req.body.project_id);
      const out = await startCodeReview(db, actor, req.body);
      return reply.status(out.status === 'skipped_draft' ? 200 : 201).send(out);
    },
  );

  // ---- start refactor review ----
  t.post(
    '/api/v1/review/refactor-runs',
    { schema: { body: refactorReviewInputSchema }, preHandler: guard(db, {}) },
    async (req, reply) => {
      const actor = requireActor(req);
      await gate('refactor_review', actor.organizationId, req.body.project_id);
      const out = await startRefactorReview(db, actor, req.body);
      return reply.status(out.status === 'skipped_draft' ? 200 : 201).send(out);
    },
  );

  // ---- findings list + decisions ----
  t.get(
    '/api/v1/review/findings',
    { schema: { querystring: listQuery }, preHandler: guard(db, {}) },
    async (req) => {
      const actor = requireActor(req);
      await assertProjectAccess(db, actor, req.query.project_id, 'project:read');
      const enabled =
        (await deps.registry.isEnabled(db, 'code_review', actor.organizationId, req.query.project_id)) ||
        (await deps.registry.isEnabled(db, 'refactor_review', actor.organizationId, req.query.project_id));
      if (!enabled) await gate('code_review', actor.organizationId, req.query.project_id);

      const { limit, cursor } = req.query;
      let q = db
        .selectFrom('review_findings')
        .select(['id', 'project_id', 'run_id', 'scope_key', 'fingerprint', 'category', 'severity', 'confidence', 'file', 'line_start', 'line_end', 'title', 'description', 'why_it_matters', 'suggestion', 'evidence', 'impact', 'effort', 'risk', 'status', 'work_item_id', 'created_at', 'updated_at'])
        .where('organization_id', '=', actor.organizationId)
        .where('project_id', '=', req.query.project_id)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1);
      if (req.query.severity) q = q.where('severity', '=', req.query.severity as never);
      if (req.query.finding_status) q = q.where('status', '=', req.query.finding_status as never);
      if (req.query.kind) {
        const runIds = db.selectFrom('review_runs').select('id').where('kind', '=', req.query.kind).where('project_id', '=', req.query.project_id);
        q = q.where('run_id', 'in', runIds);
      }
      if (cursor) {
        const c = decodeCursor(cursor);
        q = q.where((eb) => eb.or([eb('created_at', '<', new Date(c.createdAt)), eb.and([eb('created_at', '=', new Date(c.createdAt)), eb('id', '<', c.id)])]));
      }
      const rows = await q.execute();
      const page = rows.slice(0, limit);
      const next = rows.length > limit && page.length ? encodeCursor(page[page.length - 1].created_at.toISOString(), page[page.length - 1].id as string) : null;
      return {
        items: page.map((r) => ({ ...r, confidence: Number(r.confidence), created_at: r.created_at.toISOString(), updated_at: r.updated_at.toISOString() })),
        next_cursor: next,
      };
    },
  );

  t.post(
    '/api/v1/review/runs/:id/cancel',
    { schema: { params: z.object({ id: z.string().uuid() }) }, preHandler: guard(db, {}) },
    async (req) => {
      const actor = requireActor(req);
      const run = await db.selectFrom('review_runs').select(['id', 'project_id', 'kind', 'status', 'organization_id']).where('id', '=', req.params.id).executeTakeFirst();
      if (!run || run.organization_id !== actor.organizationId) throw new AppError('NOT_FOUND', 'review run not found');
      await assertProjectAccess(db, actor, run.project_id, 'review:decide');
      await gate(run.kind === 'code' ? 'code_review' : 'refactor_review', actor.organizationId, run.project_id);
      if (!['queued', 'running'].includes(run.status)) throw new AppError('CONFLICT', `run already ${run.status}`);
      await db
        .updateTable('review_runs')
        .set({ status: 'canceled', updated_at: new Date() } as never)
        .where('id', '=', run.id)
        .execute();
      await recordAudit(db, {
        organization_id: actor.organizationId,
        actor_type: actor.type === 'agent' ? 'agent' : 'user',
        actor_id: actor.id,
        action: 'review.run.cancel',
        resource_type: 'review_run',
        resource_id: run.id,
        summary: { previous_status: run.status },
        request_id: actor.requestId,
      });
      return { status: 'canceled' };
    },
  );

  const decisionBody = z.object({ status: z.enum(['dismissed', 'accepted', 'open']), reason: z.string().max(2000).optional() });
  t.post(
    '/api/v1/review/findings/:id/decision',
    { schema: { params: z.object({ id: z.string().uuid() }), body: decisionBody }, preHandler: guard(db, {}) },
    async (req) => {
      const actor = requireActor(req);
      const f = await loadFinding(db, actor.organizationId, req.params.id);
      await assertProjectAccess(db, actor, f.project_id, 'review:decide');
      const run = await db.selectFrom('review_runs').select('kind').where('id', '=', f.run_id).executeTakeFirstOrThrow();
      await gate(run.kind === 'code' ? 'code_review' : 'refactor_review', actor.organizationId, f.project_id);
      await updateFindingStatus(db, {
        organizationId: actor.organizationId,
        findingId: f.id,
        status: req.body.status,
        reason: req.body.reason,
        actorType: actor.type === 'agent' ? 'agent' : 'user',
        actorId: actor.id,
        requestId: actor.requestId,
      });
      return { status: req.body.status };
    },
  );

  t.post(
    '/api/v1/review/findings/:id/create-work-item',
    { schema: { params: z.object({ id: z.string().uuid() }) }, preHandler: guard(db, {}) },
    async (req, reply) => {
      const actor = requireActor(req);
      const f = await loadFinding(db, actor.organizationId, req.params.id);
      await assertProjectAccess(db, actor, f.project_id, 'review:decide');
      const run = await db.selectFrom('review_runs').select('kind').where('id', '=', f.run_id).executeTakeFirstOrThrow();
      await gate(run.kind === 'code' ? 'code_review' : 'refactor_review', actor.organizationId, f.project_id);
      const policy = await effectiveIssuePolicy(db, actor.organizationId, f.project_id);
      if (policy === 'record_only' && actor.type !== 'user') throw new AppError('FORBIDDEN', 'record_only policy: findings stay records');
      if (policy === 'human_approval') {
        const approved = await hasApprovedFindingRequest(db, actor.organizationId, f.id);
        if (!approved) {
          const id = await requestFindingApproval(db, actor.organizationId, f.project_id, f.id, actor.id);
          return reply.status(202).send({ approval_id: id, status: 'pending_approval' });
        }
      }
      const out = await createWorkItemFromFinding(db, {
        organizationId: actor.organizationId,
        findingId: f.id,
        actorType: actor.type === 'agent' ? 'agent' : 'user',
        actorId: actor.id,
        requestId: actor.requestId,
      });
      return reply.status(out.replayed ? 200 : 201).send(out);
    },
  );
}

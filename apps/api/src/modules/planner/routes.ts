import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AppError, planContentSchema } from '@forgepm/shared';
import { guard, requireActor } from '../../app/guards';
import { authorize } from '@forgepm/core';
import type { AppDeps } from '../../app/app';
import {
  addRevision,
  applyPlan,
  approvePlan,
  createPlan,
  generatePlan,
  getPlan,
  planDiff,
  planToDto,
} from './service';

const planDto = z.object({
  id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  goal: z.string(),
  status: z.string(),
  current_revision_id: z.string().nullable(),
  created_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export function registerPlannerRoutes(app: FastifyInstance, deps: AppDeps): void {
  const t = app.withTypeProvider<ZodTypeProvider>();
  const db = deps.db;
  const idParam = z.object({ id: z.string().uuid() });

  t.post(
    '/api/v1/projects/:id/plans',
    { schema: { params: idParam, body: z.object({ goal: z.string().min(1).max(4000), constraints: z.string().max(4000).optional() }), response: { 201: planDto } }, preHandler: guard(db, {}) },
    async (req, reply) => reply.status(201).send(await createPlan(db, requireActor(req), req.params.id, req.body.goal, req.body.constraints)),
  );

  t.get(
    '/api/v1/plans/:id',
    { schema: { params: idParam, response: { 200: planDto } }, preHandler: guard(db, {}) },
    async (req) => {
      const actor = requireActor(req);
      const p = await getPlan(db, req.params.id, actor.organizationId);
      if (!p) throw new AppError('NOT_FOUND', 'plan not found');
      return planToDto(p);
    },
  );

  // add a revision (content provided by caller) — used by manual plans.
  t.post(
    '/api/v1/plans/:id/revisions',
    { schema: { params: idParam, body: planContentSchema, response: { 201: z.object({ revision_id: z.string() }) } }, preHandler: guard(db, {}) },
    async (req, reply) => {
      const actor = requireActor(req);
      const p = await getPlan(db, req.params.id, actor.organizationId);
      if (!p) throw new AppError('NOT_FOUND', 'plan not found');
      const { validatePlan } = await import('@forgepm/core');
      const validation = validatePlan(req.body, 200);
      const revId = await addRevision(db, req.params.id, actor.organizationId, actor.id, req.body, validation);
      return reply.status(201).send({ revision_id: revId });
    },
  );

  // run generation with the org's configured provider (fake in tests).
  t.post(
    '/api/v1/plans/:id/generate',
    { schema: { params: idParam, response: { 200: z.object({ status: z.string() }) } }, preHandler: guard(db, { scope: 'plan' }) },
    async (req) => {
      const actor = requireActor(req);
      const p = await getPlan(db, req.params.id, actor.organizationId);
      if (!p) throw new AppError('NOT_FOUND', 'plan not found');
      return { status: await generatePlan(db, req.params.id, actor.organizationId) };
    },
  );

  t.post(
    '/api/v1/plans/:id/approve',
    { schema: { params: idParam, response: { 200: z.object({ status: z.string() }) } }, preHandler: guard(db, {}) },
    async (req) => {
      await approvePlan(db, requireActor(req), req.params.id);
      return { status: 'approved' };
    },
  );

  t.post(
    '/api/v1/plans/:id/apply',
    { schema: { params: idParam, body: z.object({ idempotency_key: z.string().min(1).max(200), inject_failure_at: z.string().max(80).optional() }), response: { 200: z.unknown() } }, preHandler: guard(db, {}) },
    async (req) => {
      const actor = requireActor(req);
      // approve and apply are separate; a plan with no approval cannot apply.
      if (actor.type === 'agent' && !actor.scopes.includes('plan_apply')) throw new AppError('FORBIDDEN_SCOPE', 'plan_apply scope required');
      return applyPlan(db, actor, req.params.id, { injectFailureAt: req.body.inject_failure_at });
    },
  );

  t.get(
    '/api/v1/plans/:id/apply-status',
    { schema: { params: idParam, response: { 200: planDto } }, preHandler: guard(db, {}) },
    async (req) => {
      const actor = requireActor(req);
      const p = await getPlan(db, req.params.id, actor.organizationId);
      if (!p) throw new AppError('NOT_FOUND', 'plan not found');
      return planToDto(p);
    },
  );

  t.get(
    '/api/v1/plans/:id/diff',
    { schema: { params: idParam, querystring: z.object({ from: z.coerce.number().int(), to: z.coerce.number().int() }), response: { 200: z.object({ from: z.unknown(), to: z.unknown() }) } }, preHandler: guard(db, {}) },
    async (req) => {
      const actor = requireActor(req);
      authorize({ orgRole: actor.orgRole, projectRole: actor.projectRole('') }, 'project:read');
      return planDiff(db, req.params.id, req.query.from, req.query.to);
    },
  );
}

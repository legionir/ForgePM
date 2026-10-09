import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AppError, featureDtoSchema, type FeatureDto } from '@forgepm/shared';
import {
  unitOfWork,
  recordAudit,
  workProgress,
  releaseReadiness,
  type Db,
} from '@forgepm/core';
import { guard, requireActor } from '../../app/guards';
import { assertProjectAccess } from '../projects/access';
import type { AppDeps } from '../../app/app';
import {
  getFeatureById,
  insertFeature,
  listFeatures,
  softDeleteFeature,
  updateFeature,
  type FeatureRow,
} from './repository';
import { featureStateCounts } from '../work-items';
import {
  featureSchema,
  updateFeatureSchema,
} from '@forgepm/shared';

async function rowToDto(db: Db, r: FeatureRow): Promise<FeatureDto> {
  const counts = await featureStateCounts(db, r.id);
  return {
    id: r.id,
    organization_id: r.organization_id,
    project_id: r.project_id,
    key: r.key,
    title: r.title,
    description: r.description,
    lifecycle_status: r.lifecycle_status,
    target_release: r.target_release,
    milestone_id: r.milestone_id,
    acceptance_criteria: r.acceptance_criteria ?? [],
    work_progress: workProgress(counts),
    release_readiness: releaseReadiness(r.acceptance_criteria ?? []),
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

export function registerFeaturesRoutes(app: FastifyInstance, deps: AppDeps): void {
  const t = app.withTypeProvider<ZodTypeProvider>();
  const db = deps.db;

  t.get(
    '/api/v1/projects/:id/features',
    {
      schema: { params: z.object({ id: z.string().uuid() }), response: { 200: z.object({ items: z.array(featureDtoSchema) }) } },
      preHandler: guard(db, {}),
    },
    async (req) => {
      const actor = requireActor(req);
      await assertProjectAccess(db, actor, req.params.id, 'project:read');
      const rows = await listFeatures(db, req.params.id);
      return { items: await Promise.all(rows.map((r) => rowToDto(db, r))) };
    },
  );

  t.post(
    '/api/v1/projects/:id/features',
    {
      schema: { params: z.object({ id: z.string().uuid() }), body: featureSchema, response: { 201: featureDtoSchema } },
      preHandler: guard(db, {}),
    },
    async (req, reply) => {
      const actor = requireActor(req);
      await assertProjectAccess(db, actor, req.params.id, 'project:write');
      let featureId = '';
      await unitOfWork(db, async ({ tx }) => {
        featureId = await insertFeature(tx as never, {
          organization_id: actor.organizationId,
          project_id: req.params.id,
          key: req.body.key,
          title: req.body.title,
          description: req.body.description ?? null,
          target_release: req.body.target_release ?? null,
          milestone_id: req.body.milestone_id ?? null,
          acceptance_criteria: req.body.acceptance_criteria ?? [],
        });
        await recordAudit(tx, {
          organization_id: actor.organizationId,
          actor_type: actor.type === 'agent' ? 'agent' : 'user',
          actor_id: actor.id,
          action: 'feature.create',
          resource_type: 'feature',
          resource_id: featureId,
          summary: { project_id: req.params.id, key: req.body.key, title: req.body.title },
          request_id: actor.requestId,
        });
      });
      const created = await getFeatureById(db, featureId);
      if (!created) throw new AppError('INTERNAL', 'feature vanished after insert');
      return reply.status(201).send(await rowToDto(db, created));
    },
  );

  t.patch(
    '/api/v1/features/:id',
    {
      schema: { params: z.object({ id: z.string().uuid() }), body: updateFeatureSchema, response: { 200: featureDtoSchema } },
      preHandler: guard(db, {}),
    },
    async (req) => {
      const actor = requireActor(req);
      const existing = await getFeatureById(db, req.params.id);
      if (!existing) throw new AppError('NOT_FOUND', 'feature not found');
      await assertProjectAccess(db, actor, existing.project_id, 'project:write');
      const target = req.body.lifecycle_status === 'released' ? true : false;
      const ready = releaseReadiness(existing.acceptance_criteria);
      const isAdmin = actor.orgRole === 'owner' || actor.orgRole === 'admin';
      if (target && ready < 100 && !isAdmin) {
        throw new AppError('CONFLICT', `release_readiness=${ready}% — release requires 100% or an admin override`);
      }
      await unitOfWork(db, async ({ tx }) => {
        await updateFeature(tx as never, req.params.id, req.body as never);
        await recordAudit(tx, {
          organization_id: actor.organizationId,
          actor_type: actor.type === 'agent' ? 'agent' : 'user',
          actor_id: actor.id,
          action: 'feature.update',
          resource_type: 'feature',
          resource_id: req.params.id,
          summary: { patch: req.body, admin_override: target && ready < 100 },
          request_id: actor.requestId,
        });
      });
      const after = await getFeatureById(db, req.params.id);
      if (!after) throw new AppError('INTERNAL', 'feature vanished');
      return rowToDto(db, after);
    },
  );

  t.get(
    '/api/v1/features/:id/progress',
    {
      schema: { params: z.object({ id: z.string().uuid() }), response: { 200: z.object({ work_progress: z.number(), release_readiness: z.number() }) } },
      preHandler: guard(db, {}),
    },
    async (req) => {
      const actor = requireActor(req);
      const existing = await getFeatureById(db, req.params.id);
      if (!existing) throw new AppError('NOT_FOUND', 'feature not found');
      await assertProjectAccess(db, actor, existing.project_id, 'project:read');
      const counts = await featureStateCounts(db, req.params.id);
      return { work_progress: workProgress(counts), release_readiness: releaseReadiness(existing.acceptance_criteria ?? []) };
    },
  );

  t.delete(
    '/api/v1/features/:id',
    { schema: { params: z.object({ id: z.string().uuid() }) }, preHandler: guard(db, {}) },
    async (req, reply) => {
      const actor = requireActor(req);
      const existing = await getFeatureById(db, req.params.id);
      if (!existing) throw new AppError('NOT_FOUND', 'feature not found');
      await assertProjectAccess(db, actor, existing.project_id, 'project:write');
      await unitOfWork(db, async ({ tx }) => {
        await softDeleteFeature(tx as never, req.params.id);
        await recordAudit(tx, {
          organization_id: actor.organizationId,
          actor_type: actor.type === 'agent' ? 'agent' : 'user',
          actor_id: actor.id,
          action: 'feature.soft_delete',
          resource_type: 'feature',
          resource_id: req.params.id,
          summary: null,
          request_id: actor.requestId,
        });
      });
      return reply.status(204).send();
    },
  );
}

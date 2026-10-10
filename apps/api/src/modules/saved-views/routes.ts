import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { savedViewSchema, AppError } from '@forgepm/shared';
import { newId, toJsonb, unitOfWork, recordAudit } from '@forgepm/core';
import { guard, requireActor } from '../../app/guards';
import { assertProjectAccess } from '../projects/access';
import type { AppDeps } from '../../app/app';

const viewDto = z.object({
  id: z.string(),
  project_id: z.string(),
  owner_id: z.string(),
  name: z.string(),
  filter: z.unknown(),
  shared: z.boolean(),
  created_at: z.string(),
});

export function registerSavedViewsRoutes(app: FastifyInstance, deps: AppDeps): void {
  const t = app.withTypeProvider<ZodTypeProvider>();
  const db = deps.db;

  t.get(
    '/api/v1/saved-views',
    {
      schema: { querystring: z.object({ project_id: z.string().uuid() }), response: { 200: z.object({ items: z.array(viewDto) }) } },
      preHandler: guard(db, {}),
    },
    async (req) => {
      const actor = requireActor(req);
      await assertProjectAccess(db, actor, req.query.project_id, 'project:read');
      const rows = await db
        .selectFrom('saved_views')
        .select(['id', 'project_id', 'owner_id', 'name', 'filter', 'shared', 'created_at'])
        .where('project_id', '=', req.query.project_id)
        .where('deleted_at', 'is', null)
        .where((eb) => eb.or([eb('shared', '=', true), eb('owner_id', '=', actor.id)]))
        .orderBy('created_at', 'desc')
        .execute();
      return { items: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() })) };
    },
  );

  t.post(
    '/api/v1/saved-views',
    { schema: { body: savedViewSchema, response: { 201: viewDto } }, preHandler: guard(db, {}) },
    async (req, reply) => {
      const actor = requireActor(req);
      await assertProjectAccess(db, actor, req.body.project_id, 'project:read');
      const id = newId();
      await unitOfWork(db, async ({ tx }) => {
        await tx
          .insertInto('saved_views')
          .values({ id, organization_id: actor.organizationId, project_id: req.body.project_id, owner_id: actor.id, name: req.body.name, filter: toJsonb(req.body.filter) as never, shared: req.body.shared ?? false })
          .execute();
        await recordAudit(tx, {
          organization_id: actor.organizationId,
          actor_type: actor.type === 'agent' ? 'agent' : 'user',
          actor_id: actor.id,
          action: 'saved_view.create',
          resource_type: 'saved_view',
          resource_id: id,
          summary: { name: req.body.name, project_id: req.body.project_id },
          request_id: actor.requestId,
        });
      });
      return reply.status(201).send({ id, project_id: req.body.project_id, owner_id: actor.id, name: req.body.name, filter: req.body.filter, shared: req.body.shared ?? false, created_at: new Date().toISOString() });
    },
  );

  t.delete(
    '/api/v1/saved-views/:id',
    { schema: { params: z.object({ id: z.string().uuid() }) }, preHandler: guard(db, {}) },
    async (req, reply) => {
      const actor = requireActor(req);
      const existing = await db.selectFrom('saved_views').select(['id', 'owner_id']).where('id', '=', req.params.id).executeTakeFirst();
      if (!existing) throw new AppError('NOT_FOUND', 'saved view not found');
      await assertProjectAccess(db, actor, existing.project_id as string, 'project:write');
      if (existing.owner_id !== actor.id && actor.orgRole !== 'owner' && actor.orgRole !== 'admin') throw new AppError('FORBIDDEN', 'not your view');
      await unitOfWork(db, async ({ tx }) => {
        await tx.updateTable('saved_views').set({ deleted_at: new Date() as never }).where('id', '=', req.params.id).execute();
        await recordAudit(tx, {
          organization_id: actor.organizationId,
          actor_type: actor.type === 'agent' ? 'agent' : 'user',
          actor_id: actor.id,
          action: 'saved_view.delete',
          resource_type: 'saved_view',
          resource_id: req.params.id,
          summary: null,
          request_id: actor.requestId,
        });
      });
      return reply.status(204).send();
    },
  );
}

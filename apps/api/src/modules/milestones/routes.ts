import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AppError, milestoneSchema, milestoneDtoSchema, type MilestoneDto } from '@forgepm/shared';
import { newId, unitOfWork, recordAudit, workProgress, type Db } from '@forgepm/core';
import { guard, requireActor } from '../../app/guards';
import { assertProjectAccess } from '../projects/access';
import type { AppDeps } from '../../app/app';
import { milestoneStateCounts } from '../work-items';

const COLS = ['id', 'organization_id', 'project_id', 'name', 'target_date', 'status', 'created_at', 'updated_at'] as const;
type Row = { [K in (typeof COLS)[number]]: unknown } & { created_at: Date; updated_at: Date };

function toDto(r: Row, progress: number): MilestoneDto {
  return {
    id: r.id as string,
    organization_id: r.organization_id as string,
    project_id: r.project_id as string,
    name: r.name as string,
    target_date: r.target_date ? (r.target_date instanceof Date ? r.target_date.toISOString().slice(0, 10) : String(r.target_date)) : null,
    status: r.status as 'open' | 'closed',
    progress,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

async function progress(db: Db, id: string): Promise<number> {
  return workProgress(await milestoneStateCounts(db, id));
}

export function registerMilestonesRoutes(app: FastifyInstance, deps: AppDeps): void {
  const t = app.withTypeProvider<ZodTypeProvider>();
  const db = deps.db;
  const idParam = z.object({ id: z.string().uuid() });

  t.get(
    '/api/v1/projects/:id/milestones',
    {
      schema: { params: idParam, response: { 200: z.object({ items: z.array(milestoneDtoSchema) }) } },
      preHandler: guard(db, {}),
    },
    async (req) => {
      const actor = requireActor(req);
      await assertProjectAccess(db, actor, req.params.id, 'project:read');
      const rows = await db
        .selectFrom('milestones')
        .select(COLS)
        .where('project_id', '=', req.params.id)
        .where('deleted_at', 'is', null)
        .orderBy('target_date', 'asc')
        .execute();
      const items: MilestoneDto[] = [];
      for (const r of rows) items.push(toDto(r as unknown as Row, await progress(db, (r as unknown as Row).id as string)));
      return { items };
    },
  );

  t.post(
    '/api/v1/projects/:id/milestones',
    { schema: { params: idParam, body: milestoneSchema, response: { 201: milestoneDtoSchema } }, preHandler: guard(db, {}) },
    async (req, reply) => {
      const actor = requireActor(req);
      await assertProjectAccess(db, actor, req.params.id, 'project:write');
      const id = newId();
      await unitOfWork(db, async ({ tx }) => {
        await tx
          .insertInto('milestones')
          .values({
            id,
            organization_id: actor.organizationId,
            project_id: req.params.id,
            name: req.body.name,
            target_date: req.body.target_date ?? null,
          })
          .execute();
        await recordAudit(tx, {
          organization_id: actor.organizationId,
          actor_type: actor.type === 'agent' ? 'agent' : 'user',
          actor_id: actor.id,
          action: 'milestone.create',
          resource_type: 'milestone',
          resource_id: id,
          summary: { project_id: req.params.id, name: req.body.name },
          request_id: actor.requestId,
        });
      });
      const r = await db.selectFrom('milestones').select(COLS).where('id', '=', id).executeTakeFirstOrThrow();
      return reply.status(201).send(toDto(r as unknown as Row, await progress(db, id)));
    },
  );

  t.patch(
    '/api/v1/milestones/:id',
    {
      schema: {
        params: idParam,
        body: z.object({ name: z.string().min(1).max(200).optional(), target_date: z.string().date().nullable().optional(), status: z.enum(['open', 'closed']).optional() }),
        response: { 200: milestoneDtoSchema },
      },
      preHandler: guard(db, {}),
    },
    async (req) => {
      const actor = requireActor(req);
      const existing = await db.selectFrom('milestones').select(COLS).where('id', '=', req.params.id).where('deleted_at', 'is', null).executeTakeFirst();
      if (!existing) throw new AppError('NOT_FOUND', 'milestone not found');
      const row = existing as unknown as Row;
      await assertProjectAccess(db, actor, row.project_id as string, 'project:write');
      await unitOfWork(db, async ({ tx }) => {
        await tx.updateTable('milestones').set({ ...req.body, updated_at: new Date() } as never).where('id', '=', req.params.id).execute();
        await recordAudit(tx, {
          organization_id: actor.organizationId,
          actor_type: actor.type === 'agent' ? 'agent' : 'user',
          actor_id: actor.id,
          action: 'milestone.update',
          resource_type: 'milestone',
          resource_id: req.params.id,
          summary: { patch: req.body },
          request_id: actor.requestId,
        });
      });
      const after = await db.selectFrom('milestones').select(COLS).where('id', '=', req.params.id).executeTakeFirstOrThrow();
      return toDto(after as unknown as Row, await progress(db, req.params.id));
    },
  );
}

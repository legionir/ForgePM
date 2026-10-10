import type { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AppError, milestoneSchema, milestoneDtoSchema, type MilestoneDto } from '@forgepm/shared';
import { newId, unitOfWork, recordAudit, workProgress, type Db } from '@forgepm/core';
import type { Actor } from '../../app/auth-context';
import { guard, requireActor } from '../../app/guards';
import { assertProjectAccess } from '../projects/access';
import type { AppDeps } from '../../app/app';

const COLS = ['id', 'organization_id', 'project_id', 'name', 'status', 'target_date', 'created_at', 'updated_at'] as const;
type Row = { id: string; organization_id: string; project_id: string; name: string; status: string; target_date: string | null; created_at: Date; updated_at: Date; }
function toDto(r: Row, progress: number): MilestoneDto {
  return { id: r.id, organization_id: r.organization_id, project_id: r.project_id, name: r.name, status: r.status as 'open' | 'closed', progress, target_date: r.target_date ?? null, created_at: r.created_at.toISOString(), updated_at: r.updated_at.toISOString() };
}
async function progress(db: Db, id: string): Promise<number> {
  const [total, done] = await db.transaction().execute(async (tx) => [
    tx.selectFrom('work_items').select('id').where('project_id', '=', id).where('deleted_at', 'is', null).execute(),
    tx.selectFrom('work_items').select('id').where('project_id', '=', id).where('deleted_at', 'is', null).where('status', 'ilike', '%done%').execute(),
  ]);
  return workProgress(total, done);
}

const idParam = { id: z.string().uuid() };
const milestoneBody = {
  name: z.string().min(1).max(128),
  target_date: z.string().datetime({ offset: true }).nullable().optional(),
  status: z.enum(['open', 'closed']).optional(),
};

export function registerMilestonesRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;
  const t = app.withTypeProvider<{ Generics: { params: Record<string, string>; body: Record<string, unknown>; } }>();

  // GET /api/v1/projects/:id/milestones
  t.get(
    '/api/v1/projects/:id/milestones',
    { schema: { params: { id: z.string().uuid() }, querystring: z.object({ include_deleted: z.boolean().optional().default(false), limit: z.number().int().positive().min(1).max(100).default(50), offset: z.number().int().nonnegative().default(0) }), response: { 200: milestoneDtoSchema } }, preHandler: guard(db, {}) },
    async (req) => {
      const actor = requireActor(req);
      await assertProjectAccess(db, actor, req.params.id, 'project:read');
      const rows = await db
        .selectFrom('milestones')
        .select(COLS)
        .where('project_id', '=', req.params.id)
        .where('deleted_at', 'is', null)
        .orderBy('created_at', 'desc')
        .limit(req.query.limit)
        .offset(req.query.offset)
        .execute();
      const total = await db.selectFrom('milestones').select('id').where('project_id', '=', req.params.id).where('deleted_at', 'is', null).execute();
      return { items: rows.map((r) => toDto(r as unknown as Row, await progress(db, r.id as string))), total: total.length, limit: req.query.limit, offset: req.query.offset };
    },
  );

  // POST /api/v1/projects/:id/milestones
  t.post(
    '/api/v1/projects/:id/milestones',
    { schema: { params: { id: z.string().uuid() }, body: milestoneBody, response: { 201: milestoneDtoSchema } }, preHandler: guard(db, {}) },
    async (req, reply) => {
      const actor = requireActor(req);
      await assertProjectAccess(db, actor, req.params.id, 'project:write');
      const id = newId();
      await createMilestone(db, actor, req.params.id, req.body.name, req.body.target_date ?? null, req.body.status ?? 'open');
      const r = await db.selectFrom('milestones').select(COLS).where('id', '=', id).executeTakeFirstOrThrow();
      return reply.status(201).send(toDto(r as unknown as Row, await progress(db, id)));
    },
  );

  // PATCH /api/v1/milestones/:id
  t.patch(
    '/api/v1/milestones/:id',
    { schema: { params: idParam, body: milestoneBody, response: { 200: milestoneDtoSchema } }, preHandler: guard(db, {}) },
    async (req) => {
      const actor = requireActor(req);
      const existing = await db.selectFrom('milestones').select(COLS).where('id', '=', req.params.id).where('deleted_at', 'is', null).executeTakeFirst();
      if (!existing) throw new AppError('NOT_FOUND', 'milestone not found');
      const row = existing as unknown as Row;
      await assertProjectAccess(db, actor, row.project_id as string, 'project:write');
      await updateMilestone(db, actor, req.params.id, {
        name: req.body.name,
        target_date: req.body.target_date ?? undefined,
        status: req.body.status ?? undefined,
      });
      const after = await db.selectFrom('milestones').select(COLS).where('id', '=', req.params.id).executeTakeFirstOrThrow();
      return toDto(after as unknown as Row, await progress(db, req.params.id));
    },
  );

  // DELETE /api/v1/milestones/:id
  t.delete(
    '/api/v1/milestones/:id',
    { schema: { params: idParam }, preHandler: guard(db, {}) },
    async (req, reply) => {
      const actor = requireActor(req);
      const existing = await db.selectFrom('milestones').select(COLS).where('id', '=', req.params.id).where('deleted_at', 'is', null).executeTakeFirst();
      if (!existing) throw new AppError('NOT_FOUND', 'milestone not found');
      const row = existing as unknown as Row;
      await assertProjectAccess(db, actor, row.project_id as string, 'project:write');
      await unitOfWork(db, async ({ tx }) => {
        await tx.updateTable('milestones').set({ deleted_at: new Date() as never }).where('id', '=', req.params.id).execute();
        await recordAudit(tx, {
          organization_id: actor.organizationId,
          actor_type: actor.type === 'agent' ? 'agent' : 'user',
          actor_id: actor.id,
          action: 'milestone.soft_delete',
          resource_type: 'milestone',
          resource_id: req.params.id,
          summary: null,
          request_id: actor.requestId,
        });
      });
      return reply.status(204).send();
    },
  );
}

export async function createMilestone(db: Db, actor: Actor, projectId: string, name: string, targetDate: string | null, status: 'open' | 'closed'): Promise<void> {
  const id = newId();
  await unitOfWork(db, async ({ tx }) => {
    await tx
      .insertInto('milestones')
      .values({
        id,
        organization_id: actor.organizationId,
        project_id: projectId,
        name,
        target_date: targetDate,
        status,
      })
      .execute();
    await recordAudit(tx, {
      organization_id: actor.organizationId,
      actor_type: actor.type === 'agent' ? 'agent' : 'user',
      actor_id: actor.id,
      action: 'milestone.create',
      resource_type: 'milestone',
      resource_id: id,
      summary: { project_id: projectId, name },
      request_id: actor.requestId,
    });
  });
}

export async function updateMilestone(db: Db, actor: Actor, milestoneId: string, patch: { name?: string; target_date?: string | null; status?: 'open' | 'closed' }): Promise<void> {
  await unitOfWork(db, async ({ tx }) => {
    const setFields: Record<string, unknown> = { updated_at: new Date() as never };
    if (patch.name !== undefined) setFields.name = patch.name;
    if (patch.target_date !== undefined) setFields.target_date = patch.target_date;
    if (patch.status !== undefined) setFields.status = patch.status;
    await tx.updateTable('milestones').set(setFields as never).where('id', '=', milestoneId).execute();
    await recordAudit(tx, {
      organization_id: actor.organizationId,
      actor_type: actor.type === 'agent' ? 'agent' : 'user',
      actor_id: actor.id,
      action: 'milestone.update',
      resource_type: 'milestone',
      resource_id: milestoneId,
      summary: { patch },
      request_id: actor.requestId,
    });
  });
}

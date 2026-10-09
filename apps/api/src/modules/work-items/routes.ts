import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  createWorkItemSchema,
  updateWorkItemSchema,
  transitionSchema,
  relationSchema,
  commentSchema,
  workItemDtoSchema,
  bulkCreateSchema,
  externalLinkSchema,
  listQuerySchema,
  paginatedResponseSchema,
  workItemFilterSchema,
  AppError,
} from '@forgepm/shared';
import { newId, toJsonb, unitOfWork, recordAudit, type Db } from '@forgepm/core';
import type { AppDeps } from '../../app/app';
import { guard, requireActor } from '../../app/guards';
import {
  addRelation,
  bulkCreate,
  createWorkItem,
  listFor,
  patchWorkItem,
  search,
  softDelete,
  transitionWorkItem,
} from './service';
import { createState, ensureWorkflow } from './states';
import { getWorkItemByKey, loadLabels, rowToDto } from './items-repository';

const listResponse = paginatedResponseSchema(workItemDtoSchema);

export function registerWorkItemsRoutes(app: FastifyInstance, deps: AppDeps): void {
  const t = app.withTypeProvider<ZodTypeProvider>();
  const db = deps.db;
  const keyParams = z.object({ key: z.string().min(1).max(64) });
  const idParams = z.object({ id: z.string().uuid() });

  // --- workflow states ---
  t.get(
    '/api/v1/projects/:id/states',
    { schema: { params: idParams, response: { 200: z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), category: z.string(), position: z.number() })) }) } }, preHandler: guard(db, {}) },
    async (req) => {
      const actor = requireActor(req);
      return { items: await ensureWorkflow(db, req.params.id, actor.organizationId) };
    },
  );
  t.post(
    '/api/v1/projects/:id/states',
    {
      schema: { params: idParams, body: z.object({ name: z.string().min(1).max(60), category: z.enum(['backlog', 'unstarted', 'started', 'in_review', 'completed', 'canceled']), position: z.number().int().optional() }), response: { 201: z.object({ id: z.string(), name: z.string(), category: z.string(), position: z.number() }) } },
      preHandler: guard(db, {}),
    },
    async (req, reply) => {
      const actor = requireActor(req);
      const s = await createState(db, req.params.id, actor.organizationId, req.body);
      await unitOfWork(db, async ({ tx }) => {
        await recordAudit(tx, {
          organization_id: actor.organizationId,
          actor_type: 'user',
          actor_id: actor.id,
          action: 'workflow_state.create',
          resource_type: 'workflow_state',
          resource_id: s.id,
          summary: { project_id: req.params.id, name: s.name },
          request_id: actor.requestId,
        });
      });
      return reply.status(201).send(s);
    },
  );

  // --- work items ---
  const filterQs = listQuerySchema.extend({
    state_id: z.string().uuid().optional(),
    state_category: workItemFilterSchema.shape.state_category,
    type: workItemFilterSchema.shape.type,
    priority: workItemFilterSchema.shape.priority,
    assignee_user_id: z.string().uuid().optional(),
    assignee_agent_id: z.string().uuid().optional(),
    label: z.string().optional(),
    feature_id: z.string().uuid().optional(),
    milestone_id: z.string().uuid().optional(),
    due_before: z.string().optional(),
    due_after: z.string().optional(),
    q: z.string().optional(),
  });

  t.get(
    '/api/v1/projects/:id/work-items',
    { schema: { params: idParams, querystring: filterQs, response: { 200: listResponse } }, preHandler: guard(db, {}) },
    async (req) =>
      listFor(db, requireActor(req), req.params.id, {
        limit: req.query.limit,
        cursor: req.query.cursor,
        state_id: req.query.state_id,
        state_category: req.query.state_category,
        type: req.query.type,
        priority: req.query.priority,
        assignee_user_id: req.query.assignee_user_id,
        assignee_agent_id: req.query.assignee_agent_id,
        label: req.query.label,
        feature_id: req.query.feature_id,
        milestone_id: req.query.milestone_id,
        due_before: req.query.due_before,
        due_after: req.query.due_after,
        q: req.query.q,
      }),
  );

  t.post(
    '/api/v1/projects/:id/work-items',
    { schema: { params: idParams, body: createWorkItemSchema, response: { 201: workItemDtoSchema } }, preHandler: guard(db, {}) },
    async (req, reply) => reply.status(201).send(await createWorkItem(db, requireActor(req), req.params.id, req.body)),
  );

  t.get(
    '/api/v1/work-items/:key',
    { schema: { params: keyParams, response: { 200: workItemDtoSchema } }, preHandler: guard(db, {}) },
    async (req) => {
      const actor = requireActor(req);
      const row = await getWorkItemByKey(db, actor.organizationId, req.params.key);
      if (!row) throw new AppError('NOT_FOUND', 'work item not found');
      const labels = await loadLabels(db, [row.id as string]);
      return rowToDto(row, labels.get(row.id as string) ?? []);
    },
  );

  t.patch(
    '/api/v1/work-items/:key',
    { schema: { params: keyParams, body: updateWorkItemSchema, response: { 200: workItemDtoSchema } }, preHandler: guard(db, {}) },
    async (req) => patchWorkItem(db, requireActor(req), req.params.key, req.body),
  );

  t.delete(
    '/api/v1/work-items/:key',
    { schema: { params: keyParams }, preHandler: guard(db, {}) },
    async (req, reply) => {
      await softDelete(db, requireActor(req), req.params.key);
      return reply.status(204).send();
    },
  );

  t.post(
    '/api/v1/work-items/:key/transition',
    { schema: { params: keyParams, body: transitionSchema, response: { 200: workItemDtoSchema } }, preHandler: guard(db, {}) },
    async (req) => transitionWorkItem(db, requireActor(req), req.params.key, req.body.to_state_id),
  );

  t.post(
    '/api/v1/work-items/bulk',
    { schema: { body: bulkCreateSchema, response: { 201: z.unknown(), 200: z.unknown() } }, preHandler: guard(db, {}) },
    async (req, reply) => {
      const actor = requireActor(req);
      const res = await bulkCreate(db, actor, req.body.project_id ?? (await firstProjectId(db, actor)), req.body.items, req.body.idempotency_key);
      const status = (res.status ?? 201) as 200 | 201;
      return reply.status(status).send(res.response);
    },
  );

  // relations
  t.post(
    '/api/v1/work-items/:key/relations',
    { schema: { params: keyParams, body: relationSchema, response: { 201: z.object({ status: z.string() }) } }, preHandler: guard(db, {}) },
    async (req, reply) => {
      await addRelation(db, requireActor(req), req.params.key, req.body.to_key, req.body.type);
      return reply.status(201).send({ status: 'ok' });
    },
  );

  // comments
  t.get(
    '/api/v1/work-items/:key/comments',
    {
      schema: {
        params: keyParams,
        response: { 200: z.object({ items: z.array(z.object({ id: z.string(), author_type: z.string(), author_id: z.string(), kind: z.string(), body: z.string(), edited_at: z.string().nullable(), created_at: z.string() })) }) },
      },
      preHandler: guard(db, {}),
    },
    async (req) => {
      const actor = requireActor(req);
      const item = await getWorkItemByKey(db, actor.organizationId, req.params.key);
      if (!item) throw new AppError('NOT_FOUND', 'work item not found');
      const rows = await db
        .selectFrom('comments')
        .select(['id', 'author_type', 'author_id', 'kind', 'body', 'edited_at', 'created_at'])
        .where('work_item_id', '=', item.id as string)
        .where('deleted_at', 'is', null)
        .orderBy('created_at', 'asc')
        .execute();
      return { items: rows.map((c) => ({ ...c, edited_at: c.edited_at ? c.edited_at.toISOString() : null, created_at: c.created_at.toISOString() })) };
    },
  );

  t.post(
    '/api/v1/work-items/:key/comments',
    { schema: { params: keyParams, body: commentSchema, response: { 201: z.object({ id: z.string() }) } }, preHandler: guard(db, {}) },
    async (req, reply) => {
      const actor = requireActor(req);
      const item = await getWorkItemByKey(db, actor.organizationId, req.params.key);
      if (!item) throw new AppError('NOT_FOUND', 'work item not found');
      const cid = newId();
      await unitOfWork(db, async ({ tx }) => {
        await tx
          .insertInto('comments')
          .values({ id: cid, work_item_id: item.id as string, author_type: actor.type === 'agent' ? 'agent' : 'user', author_id: actor.id, kind: req.body.kind ?? 'comment', body: req.body.body })
          .execute();
        await recordAudit(tx, {
          organization_id: actor.organizationId,
          actor_type: actor.type === 'agent' ? 'agent' : 'user',
          actor_id: actor.id,
          action: 'work_item.comment',
          resource_type: 'work_item',
          resource_id: item.id as string,
          summary: { comment_id: cid },
          request_id: actor.requestId,
        });
      });
      return reply.status(201).send({ id: cid });
    },
  );

  // external links
  t.post(
    '/api/v1/work-items/:key/links',
    { schema: { params: keyParams, body: externalLinkSchema, response: { 201: z.object({ id: z.string() }) } }, preHandler: guard(db, {}) },
    async (req, reply) => {
      const actor = requireActor(req);
      const item = await getWorkItemByKey(db, actor.organizationId, req.params.key);
      if (!item) throw new AppError('NOT_FOUND', 'work item not found');
      const lid = newId();
      await unitOfWork(db, async ({ tx }) => {
        await tx
          .insertInto('work_item_external_links')
          .values({ id: lid, work_item_id: item.id as string, kind: req.body.kind, external_id: req.body.external_id, url: req.body.url, metadata: toJsonb({}) as never })
          .onConflict((oc) => oc.columns(['work_item_id', 'kind', 'external_id']).doNothing())
          .execute();
        await recordAudit(tx, {
          organization_id: actor.organizationId,
          actor_type: actor.type === 'agent' ? 'agent' : 'user',
          actor_id: actor.id,
          action: 'work_item.link',
          resource_type: 'work_item',
          resource_id: item.id as string,
          summary: { kind: req.body.kind, external_id: req.body.external_id },
          request_id: actor.requestId,
        });
      });
      return reply.status(201).send({ id: lid });
    },
  );

  // activity (unified item history from audit_events)
  t.get(
    '/api/v1/work-items/:key/activity',
    {
      schema: {
        params: keyParams,
        response: { 200: z.object({ items: z.array(z.object({ action: z.string(), actor_type: z.string(), actor_id: z.string(), summary: z.unknown().nullable(), created_at: z.string() })) }) },
      },
      preHandler: guard(db, {}),
    },
    async (req) => {
      const actor = requireActor(req);
      const item = await getWorkItemByKey(db, actor.organizationId, req.params.key);
      if (!item) throw new AppError('NOT_FOUND', 'work item not found');
      const rows = await db
        .selectFrom('audit_events')
        .select(['action', 'actor_type', 'actor_id', 'summary', 'created_at'])
        .where('resource_type', '=', 'work_item')
        .where('resource_id', '=', item.id as string)
        .orderBy('created_at', 'asc')
        .execute();
      return { items: rows.map((r) => ({ ...r, summary: r.summary ?? null, created_at: r.created_at.toISOString() })) };
    },
  );

  // global search
  t.get(
    '/api/v1/search',
    { schema: { querystring: z.object({ q: z.string().min(1).max(200), limit: listQuerySchema.shape.limit }), response: { 200: z.object({ items: z.array(workItemDtoSchema) }) } }, preHandler: guard(db, { scope: 'read' }) },
    async (req) => search(db, requireActor(req), req.query.q, req.query.limit),
  );
}

async function firstProjectId(db: Db, actor: { organizationId: string; projectIds: string[] | null }): Promise<string> {
  if (actor.projectIds?.[0]) return actor.projectIds[0];
  const r = await db.selectFrom('projects').select('id').where('organization_id', '=', actor.organizationId).where('deleted_at', 'is', null).limit(1).executeTakeFirst();
  if (!r) throw new AppError('VALIDATION_ERROR', 'project_id required for bulk create');
  return r.id;
}


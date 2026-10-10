import { z } from 'zod';
import {
  ToolRegistry,
  validatePlan,
  newId,
  recordAudit,
  type Db,
  type McpCallContext,
} from '@forgepm/core';
import {
  createWorkItemSchema,
  bulkCreateSchema,
  transitionSchema,
  commentSchema,
  createProjectSchema,
  updateProjectSchema,
  relationSchema,
  planContentSchema,
  type CreateProjectInput,
  type UpdateProjectInput,
} from '@forgepm/shared';
import type { Actor } from '../../app/auth-context';
import * as workItems from '../work-items';
import * as projects from '../projects/service';
import * as planner from '../planner/service';
import { assertProjectAccess } from '../projects/access';
import { getWorkItemByKey } from '../work-items/items-repository';
import { buildGithubTools } from '../github/mcp-tools';
import { buildReviewTools } from '../reviews/mcp-tools';
import { listPending, decide as decideApprovalSvc } from '../approvals/service';

type Tool = Parameters<ToolRegistry['register']>[0];

/** Register every core tool (plan §13). Handlers only call module services;
 *  authz + audit happen inside the service, so an agent write flows through
 *  the work-items approval gate automatically. */
export function buildToolRegistry(db: Db): ToolRegistry {
  const reg = new ToolRegistry();
  const actor = (ctx: McpCallContext): Actor => ctx.actor as unknown as Actor;
  const add = (t: Tool): void => reg.register(t);

  // ---- projects ----
  add({ name: 'project_list', description: 'List projects visible to the caller.', inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(50), cursor: z.string().optional() }), scopes: ['read'], annotations: { readOnlyHint: true },
    handler: (args, ctx) => projects.listProjectsFor(db, actor(ctx), { limit: args.limit as number, cursor: (args.cursor as string) ?? null }) as Promise<unknown> });
  add({ name: 'project_get', description: 'Get a project by id.', inputSchema: z.object({ id: z.string().uuid() }), scopes: ['read'], annotations: { readOnlyHint: true },
    handler: (args, ctx) => projects.getProject(db, actor(ctx), args.id as string) as Promise<unknown> });
  add({ name: 'project_create', description: 'Create a project (admin).', inputSchema: createProjectSchema, scopes: ['admin'], annotations: { destructiveHint: false },
    handler: (args, ctx) => projects.createProject(db, actor(ctx), args as unknown as CreateProjectInput) as Promise<unknown> });
  add({ name: 'project_update', description: 'Update a project (admin/lead).', inputSchema: z.object({ id: z.string().uuid() }).merge(updateProjectSchema), scopes: ['admin', 'write'], annotations: { destructiveHint: false },
    handler: (args, ctx) => { const id = args.id as string; const { id: _i, ...patch } = args; void _i; return projects.patchProject(db, actor(ctx), id, patch as UpdateProjectInput) as Promise<unknown>; } });
  add({ name: 'project_archive', description: 'Archive/unarchive a project (admin).', inputSchema: z.object({ id: z.string().uuid(), archived: z.boolean().default(true) }), scopes: ['admin'], annotations: { destructiveHint: true },
    handler: (args, ctx) => projects.archiveProject(db, actor(ctx), args.id as string, args.archived as boolean) as Promise<unknown> });

  // ---- work items ----
  add({ name: 'work_item_list', description: 'List/filter work items in a project.', inputSchema: z.object({ project_id: z.string().uuid(), limit: z.number().int().min(1).max(200).default(50), cursor: z.string().optional() }), scopes: ['read'], annotations: { readOnlyHint: true },
    handler: (args, ctx) => workItems.listFor(db, actor(ctx), args.project_id as string, { limit: args.limit as number, cursor: (args.cursor as string) ?? null }) as Promise<unknown> });
  add({ name: 'work_item_get', description: 'Get a work item by key (PRJ-12) or id.', inputSchema: z.object({ key: z.string() }), scopes: ['read'], annotations: { readOnlyHint: true },
    handler: async (args, ctx) => {
      const a = actor(ctx);
      const row = await getWorkItemByKey(db, a.organizationId, args.key as string);
      if (!row) throw new Error('NOT_FOUND');
      await assertProjectAccess(db, a, row.project_id as string, 'project:read');
      return workItems.reload(db, row.id as string) as unknown;
    } });
  add({ name: 'work_item_search', description: 'Full-text search work items.', inputSchema: z.object({ q: z.string().min(1), limit: z.number().int().min(1).max(200).default(25) }), scopes: ['read'], annotations: { readOnlyHint: true },
    handler: (args, ctx) => workItems.search(db, actor(ctx), args.q as string, args.limit as number) as Promise<unknown> });
  add({ name: 'work_item_create', description: 'Create a work item (agents are subject to the approval policy).', inputSchema: createWorkItemSchema.extend({ project_id: z.string().uuid() }), scopes: ['write'], annotations: { destructiveHint: false },
    handler: (args, ctx) => { const project_id = args.project_id as string; const { project_id: _p, ...rest } = args; void _p; return workItems.createWorkItem(db, actor(ctx), project_id, rest as import('@forgepm/shared').CreateWorkItemInput) as Promise<unknown>; } });
  add({ name: 'work_item_update', description: 'Update a work item content.', inputSchema: z.object({ key: z.string() }).merge(createWorkItemSchema.partial()), scopes: ['write'], annotations: { destructiveHint: false },
    handler: (args, ctx) => { const key = args.key as string; const { key: _k, ...patch } = args; void _k; return workItems.patchWorkItem(db, actor(ctx), key, patch) as Promise<unknown>; } });
  add({ name: 'work_item_transition', description: 'Transition a work item state.', inputSchema: transitionSchema.extend({ key: z.string() }), scopes: ['write'], annotations: { destructiveHint: false },
    handler: (args, ctx) => workItems.transitionWorkItem(db, actor(ctx), args.key as string, args.to_state_id as string) as Promise<unknown> });
  add({ name: 'work_item_add_comment', description: 'Add a comment to a work item.', inputSchema: commentSchema.extend({ key: z.string() }), scopes: ['write'], annotations: { destructiveHint: false },
    handler: (args, ctx) => addComment(db, actor(ctx), args.key as string, args.body as string, ctx.requestId) });
  add({ name: 'work_item_link', description: 'Relate two work items (blocks/relates_to/duplicates).', inputSchema: relationSchema.extend({ key: z.string() }), scopes: ['write'], annotations: { destructiveHint: false },
    handler: (args, ctx) => workItems.addRelation(db, actor(ctx), args.key as string, args.to_key as string, args.type as 'blocks' | 'relates_to' | 'duplicates') as Promise<unknown> });
  add({ name: 'work_item_bulk_create', description: 'Bulk create up to 100 items (idempotency_key required).', inputSchema: bulkCreateSchema, scopes: ['write'], annotations: { destructiveHint: false, idempotentHint: true },
    handler: async (args, ctx) => {
      const a = actor(ctx);
      const projectId = (args.project_id as string) ?? (await firstProject(db, a));
      const res = await workItems.bulkCreate(db, a, projectId, args.items as never, args.idempotency_key as string);
      return res.replay ? { ...(res.response as object), replayed: true } : res.response;
    } });

  // ---- planner (final Phase-4 set; NO planner_generate_work_items) ----
  add({ name: 'planner_analyze_project', description: 'Summarise a project as planner context.', inputSchema: z.object({ project_id: z.string().uuid() }), scopes: ['plan'], annotations: { readOnlyHint: true },
    handler: (args, ctx) => analyzeProject(db, actor(ctx), args.project_id as string) });
  add({ name: 'planner_create_plan', description: 'Create a plan (queues generation).', inputSchema: z.object({ project_id: z.string().uuid(), goal: z.string().min(1), constraints: z.string().optional() }), scopes: ['plan'], annotations: { destructiveHint: false },
    handler: (args, ctx) => planner.createPlan(db, actor(ctx), args.project_id as string, args.goal as string, args.constraints as string | undefined) as Promise<unknown> });
  add({ name: 'planner_get_plan', description: 'Get a plan and its current revision.', inputSchema: z.object({ plan_id: z.string().uuid() }), scopes: ['plan'], annotations: { readOnlyHint: true },
    handler: (args, ctx) => getPlanWithRevision(db, actor(ctx), args.plan_id as string) });
  add({ name: 'planner_validate_plan', description: 'Validate the current plan revision.', inputSchema: z.object({ plan_id: z.string().uuid() }), scopes: ['plan'], annotations: { readOnlyHint: true },
    handler: (args, ctx) => validatePlanTool(db, actor(ctx), args.plan_id as string) });
  add({ name: 'planner_update_revision', description: 'Add an immutable revision to a plan.', inputSchema: z.object({ plan_id: z.string().uuid(), content: planContentSchema }), scopes: ['plan'], annotations: { destructiveHint: false },
    handler: (args, ctx) => addRevisionTool(db, actor(ctx), args.plan_id as string, args.content) });
  add({ name: 'planner_approve_plan', description: 'Approve a ready plan (human only; separate from apply).', inputSchema: z.object({ plan_id: z.string().uuid() }), scopes: ['plan_approve'], annotations: { destructiveHint: false },
    handler: async (args, ctx) => { await planner.approvePlan(db, actor(ctx), args.plan_id as string); return { status: 'approved' }; } });
  add({ name: 'planner_apply_plan', description: 'Apply an approved plan (creates milestones/features/items).', inputSchema: z.object({ plan_id: z.string().uuid() }), scopes: ['plan_apply'], annotations: { destructiveHint: true, idempotentHint: true },
    handler: (args, ctx) => planner.applyPlan(db, actor(ctx), args.plan_id as string, {}) as Promise<unknown> });
  add({ name: 'planner_get_apply_status', description: 'Recover the plan + apply status.', inputSchema: z.object({ plan_id: z.string().uuid() }), scopes: ['plan'], annotations: { readOnlyHint: true },
    handler: (args, ctx) => { const p = planner.getPlan(db, args.plan_id as string, actor(ctx).organizationId); return p; } });

  // ---- approvals ----
  add({ name: 'approval_list', description: 'List pending approval requests.', inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(50) }), scopes: ['read'], annotations: { readOnlyHint: true },
    handler: async (_args, ctx) => ({ items: await listPending(db, actor(ctx).organizationId) } as unknown) as Promise<unknown> });
  add({ name: 'approval_decide', description: 'Decide an approval request (human admin only).', inputSchema: z.object({ id: z.string().uuid(), decision: z.enum(['approved', 'rejected']), reason: z.string().optional() }), scopes: ['admin'], annotations: { destructiveHint: true },
    handler: (args, ctx) => decideApprovalSvc(db, actor(ctx), args.id as string, args.decision as 'approved' | 'rejected', args.reason as string | undefined) as Promise<unknown> });

  // ---- github_* (module-gated on 'github'; only listed when enabled) ----
  for (const t of buildGithubTools(db)) add(t);

  // ---- review_* / refactor_review_* (module-gated on either review module) ----
  for (const t of buildReviewTools(db)) add(t);

  return reg;
}

async function addComment(db: Db, actor: Actor, key: string, body: string, requestId: string): Promise<unknown> {
  const item = await getWorkItemByKey(db, actor.organizationId, key);
  if (!item) throw new Error('NOT_FOUND');
  await assertProjectAccess(db, actor, item.project_id as string, 'project:write');
  const cid = newId();
  await db.transaction().execute(async (tx) => {
    await tx.insertInto('comments').values({ id: cid, work_item_id: item.id as string, author_type: actor.type === 'agent' ? 'agent' : 'user', author_id: actor.id, kind: 'comment', body }).execute();
    await recordAudit(tx, { organization_id: actor.organizationId, actor_type: actor.type === 'agent' ? 'agent' : 'user', actor_id: actor.id, action: 'work_item.comment', resource_type: 'work_item', resource_id: item.id as string, summary: { comment_id: cid }, request_id: requestId });
  });
  return { id: cid };
}

async function firstProject(db: Db, actor: Actor): Promise<string> {
  const r = await db.selectFrom('projects').select('id').where('organization_id', '=', actor.organizationId).where('deleted_at', 'is', null).limit(1).executeTakeFirst();
  return r?.id ?? actor.projectIds?.[0] ?? '';
}

async function analyzeProject(db: Db, actor: Actor, projectId: string): Promise<unknown> {
  await assertProjectAccess(db, actor, projectId, 'project:read');
  const [features, milestones] = await db.transaction().execute(async (tx) => {
    const [f, m] = await Promise.all([
      tx.selectFrom('features').select(['key', 'title']).where('project_id', '=', projectId).where('deleted_at', 'is', null).execute(),
      tx.selectFrom('milestones').select('name').where('project_id', '=', projectId).where('deleted_at', 'is', null).execute(),
    ]);
    return [f, m] as const;
  });
  return { project_id: projectId, features, milestones };
}

async function getPlanWithRevision(db: Db, actor: Actor, planId: string): Promise<unknown> {
  const plan = await planner.getPlan(db, planId, actor.organizationId);
  if (!plan) throw new Error('NOT_FOUND');
  const rev = plan.current_revision_id ? await planner.loadRevision(db, plan.current_revision_id) : undefined;
  return { ...planner.planToDto(plan), revision: rev ? { revision_no: rev.revision_no, content: rev.content, validation: rev.validation } : null };
}

async function validatePlanTool(db: Db, actor: Actor, planId: string): Promise<unknown> {
  const plan = await planner.getPlan(db, planId, actor.organizationId);
  if (!plan) throw new Error('NOT_FOUND');
  const rev = plan.current_revision_id ? await planner.loadRevision(db, plan.current_revision_id) : undefined;
  if (!rev) return { ok: false, reason: 'no revision' };
  return validatePlan(rev.content, 200);
}

async function addRevisionTool(db: Db, actor: Actor, planId: string, content: unknown): Promise<unknown> {
  const parsed = planContentSchema.parse(content);
  const validation = validatePlan(parsed, 200);
  const id = await planner.addRevision(db, planId, actor.organizationId, actor.id, parsed, validation);
  return { revision_id: id, validation };
}

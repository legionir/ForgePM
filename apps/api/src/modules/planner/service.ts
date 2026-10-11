import { sql } from 'kysely';
import {
  AppError,
  type PlanStatus,
  type PlanContent,
  type PlanFeature,
  type PlanWorkItem,
  planContentSchema,
  type ValidationReport,
} from '@forgepm/shared';
import {
  newId,
  defaultRegistry,
  toJsonb,
  unitOfWork,
  recordAudit,
  validatePlan,
  canTransition,
  nextStatus,
  getEffective,
  tokensUsedToday,
  type AiProvider,
  type Db,
  type DbLike,
  type Tx,
  type PlanEvent,
} from '@forgepm/core';
import type { Actor } from '../../app/auth-context';
import { assertProjectAccess } from '../projects/access';
import { ensureWorkflow } from '../work-items/states';

export interface PlanRow {
  id: string;
  organization_id: string;
  project_id: string;
  goal: string;
  status: PlanStatus;
  current_revision_id: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface RevisionRow {
  id: string;
  plan_id: string;
  revision_no: number;
  content: PlanContent;
  validation: ValidationReport | null;
  created_by: string;
  created_at: Date;
}

const PLAN_COLS = ['id', 'organization_id', 'project_id', 'goal', 'status', 'current_revision_id', 'created_by', 'created_at', 'updated_at'] as const;

export function planToDto(r: PlanRow) {
  return {
    id: r.id,
    organization_id: r.organization_id,
    project_id: r.project_id,
    goal: r.goal,
    status: r.status,
    current_revision_id: r.current_revision_id,
    created_by: r.created_by,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

export type ProviderResolver = (orgId: string, planId?: string) => Promise<AiProvider | null>;
let PROVIDER: ProviderResolver = async () => null;
export function setProviderResolver(fn: ProviderResolver): void {
  PROVIDER = fn;
}

export async function getPlan(db: DbLike, id: string, orgId: string): Promise<PlanRow | undefined> {
  const r = await db.selectFrom('plans').select(PLAN_COLS).where('id', '=', id).where('organization_id', '=', orgId).executeTakeFirst();
  return r as unknown as PlanRow | undefined;
}

export async function loadRevision(db: DbLike, revisionId: string, orgId?: string): Promise<RevisionRow | undefined> {
  let qb = db
    .selectFrom('plan_revisions')
    .select(['id', 'plan_id', 'revision_no', 'content', 'validation', 'created_by', 'created_at']);
  if (orgId) qb = qb.where('plan_id', 'in', db.selectFrom('plans').select('id').where('organization_id', '=', orgId));
  else qb = qb.where('id', '=', revisionId);
  const r = await qb.executeTakeFirst();
  if (!r) return undefined;
  return {
    id: r.id,
    plan_id: r.plan_id,
    revision_no: Number(r.revision_no),
    content: r.content as PlanContent,
    validation: (r.validation ?? null) as ValidationReport | null,
    created_by: r.created_by,
    created_at: r.created_at,
  };
}

/** Create a plan (status generating) and enqueue the generation job via outbox. */
export async function createPlan(db: Db, actor: Actor, projectId: string, goal: string, constraints?: string): Promise<ReturnType<typeof planToDto>> {
  await assertProjectAccess(db, actor, projectId, 'project:write');
  const id = newId();
  const fullGoal = constraints ? `${goal}\n\n# constraints\n${constraints}` : goal;
  await unitOfWork(db, async ({ tx }) => {
    await tx
      .insertInto('plans')
      .values({ id, organization_id: actor.organizationId, project_id: projectId, goal: fullGoal, status: 'generating', created_by: actor.id })
      .execute();
    await recordAudit(tx, {
      organization_id: actor.organizationId,
      actor_type: actor.type === 'agent' ? 'agent' : 'user',
      actor_id: actor.id,
      action: 'plan.create',
      resource_type: 'plan',
      resource_id: id,
      summary: { project_id: projectId, goal },
      request_id: actor.requestId,
    });
    await tx
      .insertInto('outbox')
      .values({ id: newId(), organization_id: actor.organizationId, topic: 'planner.generate', payload: toJsonb({ plan_id: id }) as never })
      .execute();
  });
  const row = await getPlan(db, id, actor.organizationId);
  return planToDto(row!);
}

/**
 * Run generation for a plan with the org's provider. Retries invalid output up
 * to 2 times, then generation_failed. No items created — only a revision.
 * When no provider is configured the plan is left `generating` (manual flow).
 */
export async function generatePlan(db: Db, planId: string, orgId: string): Promise<PlanStatus> {
  const plan = await getPlan(db, planId, orgId);
  if (!plan) throw new AppError('NOT_FOUND', 'plan not found');
  const provider = await PROVIDER(orgId, planId);
  if (!provider) return plan.status;

  // Daily token budget (plan §7): AI_BUDGET_EXCEEDED stops the job.
  const budget = (await getEffective(db as Db, 'ai.daily_token_budget', orgId, null))?.value as number | undefined;
  if (budget && budget > 0) {
    const used = await tokensUsedToday(db, orgId);
    if (used >= budget) {
      throw new AppError('AI_BUDGET_EXCEEDED', `daily token budget ${budget} exhausted (${used} used)`);
    }
  }

  let lastErr = '';
  let content: PlanContent | null = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const res = await provider.generateStructured<PlanContent>({
        system: 'You are a planning agent. Return JSON matching the plan schema.',
        messages: [{ role: 'user', content: `${plan.goal}${lastErr ? `\nPrevious output invalid: ${lastErr}` : ''}` }],
        schema: planContentSchema,
      });
      content = res.value;
      await recordAiCall(db, orgId, provider, res.tokens_in, res.tokens_out, 'ok');
      break;
    } catch (e) {
      if (e instanceof AppError && e.code === 'AI_BUDGET_EXCEEDED') throw e;
      lastErr = (e as Error).message;
      await recordAiCall(db, orgId, provider, 0, 0, 'error');
    }
  }
  if (!content) {
    await transition(db, planId, orgId, 'generate_invalid', null, { code: 'PLAN_GENERATION_INVALID', message: lastErr });
    return 'generation_failed';
  }
  const validation = validatePlan(content, 200);
  await addRevision(db, planId, orgId, 'system', content, validation);
  await transition(db, planId, orgId, content.open_questions.length > 0 ? 'generate_needs_clarification' : 'generate_ok', null, validation);
  return content.open_questions.length > 0 ? 'needs_clarification' : 'ready';
}

async function recordAiCall(db: Db, orgId: string, provider: AiProvider, tin: number, tout: number, status: 'ok' | 'error'): Promise<void> {
  const row = await db
    .selectFrom('ai_providers')
    .select('id')
    .where('organization_id', '=', orgId)
    .where('kind', '=', provider.kind as never)
    .limit(1)
    .executeTakeFirst();
  if (!row) return;
  await db
    .insertInto('ai_calls')
    .values({ id: newId(), organization_id: orgId, provider_id: row.id, model: provider.model, purpose: 'planner', tokens_in: tin, tokens_out: tout, latency_ms: null, status })
    .execute();
  defaultRegistry.inc('forgepm_ai_calls_total', { purpose: 'planner', status });
}

export async function addRevision(db: Db, planId: string, orgId: string, createdBy: string, content: PlanContent, validation: ValidationReport | null): Promise<string> {
  const plan = await getPlan(db, planId, orgId);
  if (!plan) throw new AppError('NOT_FOUND', 'plan not found');
  const revId = newId();
  await db.transaction().execute(async (tx) => {
    const maxRow = await tx
      .selectFrom('plan_revisions')
      .select(sql<number>`COALESCE(MAX(revision_no), 0)::int`.as('max_no'))
      .where('plan_id', '=', planId)
      .executeTakeFirst();
    const no = Number(maxRow?.max_no ?? 0) + 1;
    await tx
      .insertInto('plan_revisions')
      .values({ id: revId, plan_id: planId, revision_no: no, content: toJsonb(content) as never, validation: validation ? (toJsonb(validation) as never) : null, created_by: createdBy })
      .execute();
    await tx.updateTable('plans').set({ current_revision_id: revId, updated_at: new Date() } as never).where('id', '=', planId).execute();
  });
  return revId;
}

/** Move a plan through the state machine; illegal transitions => 409. */
export async function transition(db: Db, planId: string, orgId: string, event: PlanEvent, actorId: string | null, details?: unknown): Promise<PlanStatus> {
  const plan = await getPlan(db, planId, orgId);
  if (!plan) throw new AppError('NOT_FOUND', 'plan not found');
  const to = nextStatus(plan.status, event);
  if (!canTransition(plan.status, to)) throw new AppError('CONFLICT', `illegal transition ${plan.status} -> ${to}`);
  await db.transaction().execute(async (tx) => {
    await tx.updateTable('plans').set({ status: to, updated_at: new Date() } as never).where('id', '=', planId).execute();
    if (actorId) {
      await recordAudit(tx, {
        organization_id: orgId,
        actor_type: 'user',
        actor_id: actorId,
        action: `plan.${event}`,
        resource_type: 'plan',
        resource_id: planId,
        summary: { from: plan.status, to, details: details ?? null },
        request_id: null,
      });
    }
  });
  return to;
}

export async function approvePlan(db: Db, actor: Actor, planId: string): Promise<void> {
  const plan = await getPlan(db, planId, actor.organizationId);
  if (!plan) throw new AppError('NOT_FOUND', 'plan not found');
  // Self-approval is forbidden first so the specific error surfaces even when
  // the agent also lacks project approval membership.
  if (actor.type === 'agent' && plan.created_by === actor.id) {
    throw new AppError('FORBIDDEN_SELF_APPROVAL', 'an agent cannot approve its own plan');
  }
  if (actor.type === 'agent' && !actor.scopes.includes('plan_approve')) {
    throw new AppError('FORBIDDEN_SCOPE', 'plan_approve scope required');
  }
  await assertProjectAccess(db, actor, plan.project_id, 'plan:approve');
  if (plan.status !== 'ready') throw new AppError('CONFLICT', `cannot approve from status ${plan.status}`);
  const rev = plan.current_revision_id ? await loadRevision(db, plan.current_revision_id) : undefined;
  if (!rev || !rev.validation?.ok) {
    throw new AppError('PLAN_INVALID', 'plan must be valid before approval', { cycles: rev?.validation?.cycles ?? [] });
  }
  await transition(db, planId, actor.organizationId, 'approve', actor.id);
}

interface ApplyCounts {
  milestones: number;
  features: number;
  work_items: number;
  relations: number;
  skipped: { item: string; reason: string }[];
  error?: string;
}

/**
 * Apply a plan in ONE transaction: milestones/features/work items/relations
 * with source=planner. `injectFailureAt` aborts the tx (full rollback) so the
 * caller can prove no partial data survives; apply_failed is recorded outside.
 */
export async function applyPlan(db: Db, actor: Actor, planId: string, opts: { injectFailureAt?: string }): Promise<Record<string, unknown>> {
  const plan = await getPlan(db, planId, actor.organizationId);
  if (!plan) throw new AppError('NOT_FOUND', 'plan not found');
  await assertProjectAccess(db, actor, plan.project_id, 'plan:apply');
  if (plan.status !== 'approved') throw new AppError('CONFLICT', `cannot apply from status ${plan.status}`);
  const rev = plan.current_revision_id ? await loadRevision(db, plan.current_revision_id) : undefined;
  if (!rev) throw new AppError('CONFLICT', 'plan has no revision');

  try {
    const counts = await db.transaction().execute(async (tx: Tx) => {
      const c: ApplyCounts = { milestones: 0, features: 0, work_items: 0, relations: 0, skipped: [] };
      const tempToId = new Map<string, string>();
      await ensureWorkflow(tx as never, plan.project_id, actor.organizationId);
      await tx.updateTable('plans').set({ status: 'applying', updated_at: new Date() } as never).where('id', '=', planId).execute();

      for (const m of rev.content.milestones) {
        maybeFail(opts.injectFailureAt, `milestone:${m.temp_id}`);
        const id = newId();
        await tx.insertInto('milestones').values({ id, organization_id: actor.organizationId, project_id: plan.project_id, name: m.name, target_date: m.target_date ?? null }).execute();
        tempToId.set(m.temp_id, id);
        c.milestones++;
      }

      let num = await currentNumber(db, plan.project_id);
      const features: (PlanFeature & { _milestone?: string })[] = [];
      for (const f of rev.content.features) features.push(f);
      for (const mm of rev.content.milestones) for (const f of mm.features) features.push({ ...f, _milestone: mm.temp_id });

      for (const f of features) {
        maybeFail(opts.injectFailureAt, `feature:${f.temp_id}`);
        const id = newId();
        await tx
          .insertInto('features')
          .values({
            id,
            organization_id: actor.organizationId,
            project_id: plan.project_id,
            key: f.key,
            title: f.title,
            description: f.description ?? null,
            milestone_id: f._milestone ? ((tempToId.get(f._milestone) as string) ?? null) : null,
            acceptance_criteria: toJsonb(f.acceptance_criteria) as never,
          })
          .execute();
        tempToId.set(f.temp_id, id);
        c.features++;
        for (const wi of f.work_items) {
          const wiId = await insertPlannedItem(tx, actor, plan.project_id, num++, wi, tempToId, opts.injectFailureAt, f.temp_id);
          tempToId.set(wi.temp_id, wiId);
          c.work_items++;
        }
      }

      for (const wi of rev.content.work_items) {
        const wiId = await insertPlannedItem(tx, actor, plan.project_id, num++, wi, tempToId, opts.injectFailureAt, undefined);
        tempToId.set(wi.temp_id, wiId);
        c.work_items++;
      }

      const allItems: PlanWorkItem[] = [...features.flatMap((f) => f.work_items), ...rev.content.work_items];
      for (const it of allItems) {
        const toId = tempToId.get(it.temp_id);
        if (!toId) continue;
        for (const dep of it.depends_on) {
          const fromId = tempToId.get(dep);
          if (!fromId) {
            c.skipped.push({ item: it.temp_id, reason: `unknown dependency ${dep}` });
            continue;
          }
          await tx
            .insertInto('work_item_relations')
            .values({ id: newId(), from_id: fromId, to_id: toId, type: 'blocks' })
            .onConflict((oc) => oc.columns(['from_id', 'to_id', 'type']).doNothing())
            .execute();
          c.relations++;
        }
      }

      maybeFail(opts.injectFailureAt, 'commit');
      await tx.updateTable('plans').set({ status: 'applied', updated_at: new Date() } as never).where('id', '=', planId).execute();
      await tx.updateTable('projects').set({ next_item_number: num } as never).where('id', '=', plan.project_id).execute();
      await recordAudit(tx, {
        organization_id: actor.organizationId,
        actor_type: actor.type === 'agent' ? 'agent' : 'user',
        actor_id: actor.id,
        action: 'plan.apply',
        resource_type: 'plan',
        resource_id: planId,
        summary: c,
        request_id: actor.requestId,
      });
      return c;
    });
    return { status: 'applied', plan_id: planId, ...counts };
  } catch (e) {
    await db.updateTable('plans').set({ status: 'apply_failed', updated_at: new Date() } as never).where('id', '=', planId).execute();
    return { status: 'apply_failed', plan_id: planId, rolled_back: true, error: (e as Error).message };
  }
}

function maybeFail(injectAt: string | undefined, marker: string): void {
  if (injectAt === marker) throw new Error(`injected failure at ${marker}`);
}

async function insertPlannedItem(
  tx: Tx,
  actor: Actor,
  projectId: string,
  number: number,
  wi: PlanWorkItem,
  tempToId: Map<string, string>,
  injectAt: string | undefined,
  featureTempId: string | undefined,
): Promise<string> {
  maybeFail(injectAt, `item:${wi.temp_id}`);
  const state = await tx.selectFrom('workflow_states').select('id').where('project_id', '=', projectId).where('category', '=', 'backlog').limit(1).executeTakeFirst();
  const id = newId();
  await tx
    .insertInto('work_items')
    .values({
      id,
      organization_id: actor.organizationId,
      project_id: projectId,
      number,
      type: wi.type,
      title: wi.title,
      description: wi.description ?? null,
      state_id: state?.id ?? newId(),
      priority: wi.priority,
      source: 'planner',
      acceptance_criteria: toJsonb(wi.acceptance_criteria ?? []) as never,
      feature_id: featureTempId ? ((tempToId.get(featureTempId) as string) ?? null) : null,
    })
    .execute();
  return id;
}

async function currentNumber(db: DbLike, projectId: string): Promise<number> {
  const r = await db.selectFrom('projects').select('next_item_number').where('id', '=', projectId).executeTakeFirst();
  return Number(r?.next_item_number ?? 1);
}

export async function planDiff(db: DbLike, planId: string, fromNo: number, toNo: number): Promise<{ from: unknown; to: unknown }> {
  const from = await sql`SELECT content FROM plan_revisions WHERE plan_id = ${planId} AND revision_no = ${fromNo}`.execute(db);
  const to = await sql`SELECT content FROM plan_revisions WHERE plan_id = ${planId} AND revision_no = ${toNo}`.execute(db);
  return { from: (from.rows[0] as { content?: unknown })?.content ?? null, to: (to.rows[0] as { content?: unknown })?.content ?? null };
}

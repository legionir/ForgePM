import { sql } from 'kysely';
import { newId, toJsonb, type DbLike } from '@forgepm/core';
import type { WorkItemDto, WorkItemFilter, AcceptanceCriterion } from '@forgepm/shared';

export type RawRow = Record<string, unknown>;

export interface ListArgs extends WorkItemFilter {
  organizationId: string;
  projectId?: string;
  limit: number;
  cursor?: string | null;
}

/** Parse `PRJ-12` or a raw uuid into lookup parts. */
export function parseKey(key: string): { projectKey?: string; number?: number; id?: string } {
  const m = /^([A-Za-z]{2,5})-(\d+)$/.exec(key);
  if (m) return { projectKey: m[1].toUpperCase(), number: Number(m[2]) };
  return { id: key };
}

export function rowToDto(r: RawRow, labels: string[]): WorkItemDto {
  const projectKey = r.project_key as string;
  return {
    id: r.id as string,
    organization_id: r.organization_id as string,
    project_id: r.project_id as string,
    project_key: projectKey,
    number: Number(r.number),
    key: `${projectKey}-${r.number}`,
    type: r.type as WorkItemDto['type'],
    title: r.title as string,
    description: (r.description as string | null) ?? null,
    state_id: r.state_id as string,
    state_name: r.state_name as string,
    state_category: r.state_category as WorkItemDto['state_category'],
    priority: r.priority as WorkItemDto['priority'],
    assignee_user_id: (r.assignee_user_id as string | null) ?? null,
    assignee_agent_id: (r.assignee_agent_id as string | null) ?? null,
    reporter_id: (r.reporter_id as string | null) ?? null,
    estimate: r.estimate === null || r.estimate === undefined ? null : String(r.estimate),
    due_date: r.due_date ? (r.due_date instanceof Date ? (r.due_date as Date).toISOString().slice(0, 10) : String(r.due_date)) : null,
    parent_id: (r.parent_id as string | null) ?? null,
    feature_id: (r.feature_id as string | null) ?? null,
    milestone_id: (r.milestone_id as string | null) ?? null,
    acceptance_criteria: Array.isArray(r.acceptance_criteria) ? (r.acceptance_criteria as AcceptanceCriterion[]) : [],
    source: r.source as WorkItemDto['source'],
    plan_id: (r.plan_id as string | null) ?? null,
    labels,
    created_at: (r.created_at as Date).toISOString(),
    updated_at: (r.updated_at as Date).toISOString(),
  };
}

export async function loadLabels(db: DbLike, ids: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (ids.length === 0) return map;
  const rows = await db
    .selectFrom('work_item_labels')
    .innerJoin('labels', 'labels.id', 'work_item_labels.label_id')
    .select(['work_item_labels.work_item_id as wi', 'labels.name as name'])
    .where('work_item_labels.work_item_id', 'in', ids)
    .execute();
  for (const r of rows) {
    const arr = map.get(r.wi) ?? [];
    arr.push(r.name);
    map.set(r.wi, arr);
  }
  return map;
}

const PROJECTION = [
  'wi.id as id',
  'wi.organization_id as organization_id',
  'wi.project_id as project_id',
  'p.key as project_key',
  'wi.number as number',
  'wi.type as type',
  'wi.title as title',
  'wi.description as description',
  'wi.state_id as state_id',
  'ws.name as state_name',
  'ws.category as state_category',
  'wi.priority as priority',
  'wi.assignee_user_id as assignee_user_id',
  'wi.assignee_agent_id as assignee_agent_id',
  'wi.reporter_id as reporter_id',
  'wi.estimate as estimate',
  'wi.due_date as due_date',
  'wi.parent_id as parent_id',
  'wi.feature_id as feature_id',
  'wi.milestone_id as milestone_id',
  'wi.acceptance_criteria as acceptance_criteria',
  'wi.source as source',
  'wi.plan_id as plan_id',
  'wi.created_at as created_at',
  'wi.updated_at as updated_at',
] as const;

function base(db: DbLike, args: ListArgs) {
  let q = db
    .selectFrom('work_items as wi')
    .innerJoin('projects as p', 'p.id', 'wi.project_id')
    .innerJoin('workflow_states as ws', 'ws.id', 'wi.state_id')
    .select(PROJECTION as never)
    .where('wi.deleted_at', 'is', null)
    .where('wi.organization_id', '=', args.organizationId);
  if (args.projectId) q = q.where('wi.project_id', '=', args.projectId);
  if (args.state_id) q = q.where('wi.state_id', '=', args.state_id);
  if (args.state_category) q = q.where('ws.category', '=', args.state_category);
  if (args.type) q = q.where('wi.type', '=', args.type);
  if (args.priority) q = q.where('wi.priority', '=', args.priority);
  if (args.assignee_user_id) q = q.where('wi.assignee_user_id', '=', args.assignee_user_id);
  if (args.assignee_agent_id) q = q.where('wi.assignee_agent_id', '=', args.assignee_agent_id);
  if (args.feature_id) q = q.where('wi.feature_id', '=', args.feature_id);
  if (args.milestone_id) q = q.where('wi.milestone_id', '=', args.milestone_id);
  if (args.due_before) q = q.where('wi.due_date', '<=', args.due_before);
  if (args.due_after) q = q.where('wi.due_date', '>=', args.due_after);
  if (args.label) {
    q = q.where((eb) =>
      eb.exists(
        eb
          .selectFrom('work_item_labels as wil')
          .innerJoin('labels as l', 'l.id', 'wil.label_id')
          .whereRef('wil.work_item_id', '=', 'wi.id')
          .where('l.name', '=', args.label as string)
          .select('l.id'),
      ),
    );
  }
  if (args.q) {
    q = q.where(sql<boolean>`wi.search_vector @@ plainto_tsquery('simple', ${args.q})` as never);
  }
  if (args.cursor) {
    const raw = Buffer.from(args.cursor, 'hex').toString('utf8');
    const i = raw.indexOf('|');
    const createdAt = raw.slice(0, i);
    const id = raw.slice(i + 1);
    q = q.where((eb) =>
      eb.or([
        eb('wi.created_at', '<', new Date(createdAt)),
        eb.and([eb('wi.created_at', '=', new Date(createdAt)), eb('wi.id', '<', id)]),
      ]),
    );
  }
  return q;
}

export async function listWorkItems(db: DbLike, args: ListArgs): Promise<{ rows: RawRow[]; hasMore: boolean }> {
  const result = await base(db, args)
    .orderBy(sql`wi.created_at DESC`)
    .orderBy(sql`wi.id DESC`)
    .limit(args.limit + 1)
    .execute();
  const rows = result as unknown as RawRow[];
  return { rows, hasMore: rows.length > args.limit };
}

/** Global search across title+description (GIN) within the actor's org. */
export async function searchWorkItems(db: DbLike, orgId: string, q: string, limit: number, restrictProjectIds: string[] | null): Promise<RawRow[]> {
  let query = db
    .selectFrom('work_items as wi')
    .innerJoin('projects as p', 'p.id', 'wi.project_id')
    .innerJoin('workflow_states as ws', 'ws.id', 'wi.state_id')
    .select(PROJECTION as never)
    .where('wi.deleted_at', 'is', null)
    .where('wi.organization_id', '=', orgId)
    .where(sql<boolean>`wi.search_vector @@ plainto_tsquery('simple', ${q})` as never);
  if (restrictProjectIds) query = query.where('wi.project_id', 'in', restrictProjectIds);
  const rows = await query.orderBy(sql`wi.created_at DESC`).limit(limit).execute();
  return rows as unknown as RawRow[];
}

export async function getWorkItemByKey(db: DbLike, orgId: string, key: string): Promise<RawRow | undefined> {
  const parsed = parseKey(key);
  let q = db
    .selectFrom('work_items as wi')
    .innerJoin('projects as p', 'p.id', 'wi.project_id')
    .innerJoin('workflow_states as ws', 'ws.id', 'wi.state_id')
    .select(PROJECTION as never)
    .where('wi.deleted_at', 'is', null)
    .where('wi.organization_id', '=', orgId);
  if (parsed.projectKey && parsed.number !== undefined) {
    q = q.where('p.key', '=', parsed.projectKey).where('wi.number', '=', parsed.number);
  } else {
    q = q.where('wi.id', '=', parsed.id as string);
  }
  const rows = await q.execute();
  return (rows as unknown as RawRow[])[0];
}

export async function getWorkItemById(db: DbLike, id: string): Promise<RawRow | undefined> {
  const rows = await db
    .selectFrom('work_items as wi')
    .innerJoin('projects as p', 'p.id', 'wi.project_id')
    .innerJoin('workflow_states as ws', 'ws.id', 'wi.state_id')
    .select(PROJECTION as never)
    .where('wi.id', '=', id)
    .where('wi.deleted_at', 'is', null)
    .execute();
  return (rows as unknown as RawRow[])[0];
}

export interface NewWorkItemValues {
  organization_id: string;
  project_id: string;
  number: number;
  type: string;
  title: string;
  description?: string | null;
  state_id: string;
  priority?: string;
  assignee_user_id?: string | null;
  assignee_agent_id?: string | null;
  reporter_id?: string | null;
  estimate?: number | null;
  due_date?: string | null;
  parent_id?: string | null;
  feature_id?: string | null;
  milestone_id?: string | null;
  acceptance_criteria?: AcceptanceCriterion[];
  source?: string;
  plan_id?: string | null;
}

export async function insertWorkItem(db: DbLike, v: NewWorkItemValues): Promise<string> {
  const id = newId();
  await db
    .insertInto('work_items')
    .values({
      id,
      organization_id: v.organization_id,
      project_id: v.project_id,
      number: v.number,
      type: v.type as never,
      title: v.title,
      description: v.description ?? null,
      state_id: v.state_id,
      priority: v.priority as never,
      assignee_user_id: v.assignee_user_id ?? null,
      assignee_agent_id: v.assignee_agent_id ?? null,
      reporter_id: v.reporter_id ?? null,
      estimate: v.estimate === null || v.estimate === undefined ? null : String(v.estimate),
      due_date: v.due_date ?? null,
      parent_id: v.parent_id ?? null,
      feature_id: v.feature_id ?? null,
      milestone_id: v.milestone_id ?? null,
      acceptance_criteria: toJsonb(v.acceptance_criteria ?? []) as never,
      source: v.source as never,
      plan_id: v.plan_id ?? null,
    })
    .execute();
  return id;
}

/** Replace an item's labels by name (creates labels on the fly). */
export async function setWorkItemLabels(db: DbLike, workItemId: string, labelNames: string[], orgId: string, projectId: string): Promise<void> {
  await db.deleteFrom('work_item_labels').where('work_item_id', '=', workItemId).execute();
  for (const name of labelNames) {
    let label = await db.selectFrom('labels').select('id').where('project_id', '=', projectId).where('name', '=', name).executeTakeFirst();
    if (!label) {
      await db
        .insertInto('labels')
        .values({ id: newId(), organization_id: orgId, project_id: projectId, name, color: '#888888' })
        .onConflict((oc) => oc.columns(['project_id', 'name']).doNothing())
        .execute();
      label = await db.selectFrom('labels').select('id').where('project_id', '=', projectId).where('name', '=', name).executeTakeFirst();
    }
    if (label) {
      await db
        .insertInto('work_item_labels')
        .values({ work_item_id: workItemId, label_id: label.id })
        .onConflict((oc) => oc.columns(['work_item_id', 'label_id']).doNothing())
        .execute();
    }
  }
}

export async function updateWorkItemFields(db: DbLike, id: string, patch: Partial<NewWorkItemValues>): Promise<void> {
  const set: Record<string, unknown> = { updated_at: new Date() };
  for (const [k, val] of Object.entries(patch)) {
    if (val === undefined) continue;
    set[k] = k === 'acceptance_criteria' ? toJsonb(val) : val;
  }
  await db.updateTable('work_items').set(set as never).where('id', '=', id).execute();
}

export async function softDeleteWorkItem(db: DbLike, id: string): Promise<void> {
  await db.updateTable('work_items').set({ deleted_at: new Date(), updated_at: new Date() }).where('id', '=', id).execute();
}

/** Category counts for a feature's work items (plan §6.4 work_progress). */
export async function featureStateCounts(db: DbLike, featureId: string): Promise<{ completed: number; canceled: number; total: number }> {
  const rows = await db
    .selectFrom('work_items as wi')
    .innerJoin('workflow_states as ws', 'ws.id', 'wi.state_id')
    .select(['ws.category as category', sql<number>`count(*)::int`.as('n')])
    .where('wi.feature_id', '=', featureId)
    .where('wi.deleted_at', 'is', null)
    .groupBy('ws.category')
    .execute();
  let completed = 0;
  let canceled = 0;
  let total = 0;
  for (const r of rows) {
    total += r.n;
    if (r.category === 'completed') completed += r.n;
    if (r.category === 'canceled') canceled += r.n;
  }
  return { completed, canceled, total };
}

/** Milestone progress: completed / non-canceled items in the milestone. */
export async function milestoneStateCounts(db: DbLike, milestoneId: string): Promise<{ completed: number; canceled: number; total: number }> {
  const rows = await db
    .selectFrom('work_items as wi')
    .innerJoin('workflow_states as ws', 'ws.id', 'wi.state_id')
    .select(['ws.category as category', sql<number>`count(*)::int`.as('n')])
    .where('wi.milestone_id', '=', milestoneId)
    .where('wi.deleted_at', 'is', null)
    .groupBy('ws.category')
    .execute();
  let completed = 0;
  let canceled = 0;
  let total = 0;
  for (const r of rows) {
    total += r.n;
    if (r.category === 'completed') completed += r.n;
    if (r.category === 'canceled') canceled += r.n;
  }
  return { completed, canceled, total };
}

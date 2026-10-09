import { newId, toJsonb, type DbLike } from '@forgepm/core';
import type { AcceptanceCriterion } from '@forgepm/shared';

export interface FeatureRow {
  id: string;
  organization_id: string;
  project_id: string;
  key: string;
  title: string;
  description: string | null;
  lifecycle_status: 'proposed' | 'planned' | 'in_progress' | 'in_validation' | 'released' | 'deprecated';
  target_release: string | null;
  milestone_id: string | null;
  acceptance_criteria: AcceptanceCriterion[];
  created_at: Date;
  updated_at: Date;
}

const PROJECTION = [
  'id',
  'organization_id',
  'project_id',
  'key',
  'title',
  'description',
  'lifecycle_status',
  'target_release',
  'milestone_id',
  'acceptance_criteria',
  'created_at',
  'updated_at',
] as const;

export async function listFeatures(db: DbLike, projectId: string): Promise<FeatureRow[]> {
  const rows = await db
    .selectFrom('features')
    .select(PROJECTION)
    .where('project_id', '=', projectId)
    .where('deleted_at', 'is', null)
    .orderBy('created_at', 'asc')
    .execute();
  return rows as unknown as FeatureRow[];
}

export async function getFeatureByKey(db: DbLike, orgId: string, projectKey: string, key: string): Promise<FeatureRow | undefined> {
  const rows = await db
    .selectFrom('features')
    .select(PROJECTION)
    .innerJoin('projects', 'projects.id', 'features.project_id')
    .where('features.deleted_at', 'is', null)
    .where('features.organization_id', '=', orgId)
    .where('projects.key', '=', projectKey)
    .where('features.key', '=', key)
    .execute();
  return (rows as unknown as FeatureRow[])[0];
}

export async function getFeatureById(db: DbLike, id: string): Promise<FeatureRow | undefined> {
  const r = await db.selectFrom('features').select(PROJECTION).where('id', '=', id).where('deleted_at', 'is', null).executeTakeFirst();
  return r as unknown as FeatureRow | undefined;
}

export async function insertFeature(
  db: DbLike,
  v: {
    organization_id: string;
    project_id: string;
    key: string;
    title: string;
    description?: string | null;
    target_release?: string | null;
    milestone_id?: string | null;
    acceptance_criteria?: AcceptanceCriterion[];
  },
): Promise<string> {
  const id = newId();
  await db
    .insertInto('features')
    .values({
      id,
      organization_id: v.organization_id,
      project_id: v.project_id,
      key: v.key,
      title: v.title,
      description: v.description ?? null,
      target_release: v.target_release ?? null,
      milestone_id: v.milestone_id ?? null,
      acceptance_criteria: toJsonb(v.acceptance_criteria ?? []) as never,
    })
    .execute();
  return id;
}

export async function updateFeature(db: DbLike, id: string, patch: Partial<FeatureRow>): Promise<void> {
  const set: Record<string, unknown> = { updated_at: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    set[k] = k === 'acceptance_criteria' ? toJsonb(v) : v;
  }
  await db.updateTable('features').set(set as never).where('id', '=', id).execute();
}

export async function softDeleteFeature(db: DbLike, id: string): Promise<void> {
  await db.updateTable('features').set({ deleted_at: new Date(), updated_at: new Date() }).where('id', '=', id).execute();
}

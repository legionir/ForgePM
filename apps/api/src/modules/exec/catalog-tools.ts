import { sql } from 'kysely';
import { z } from 'zod';
import { AppError, featureSchema, milestoneSchema } from '@forgepm/shared';
import { newId, recordAudit, toJsonb, unitOfWork, type Db, type DbLike } from '@forgepm/core';
import type { Actor } from '../../app/auth-context';
import { createMilestone } from '../milestones/routes';
import { parseTool, projectRefSchema, resolveProject } from './context';

/**
 * Features and milestones for the execution ledger.
 *
 * `exec_task_start` and `task_split` accept `feature_ref` / `milestone_ref`; an agent can only use them if it can
 * see what exists and make what is missing. A key with only the ledger scopes cannot reach the product's own
 * feature and milestone tools, so these four are the ledger's way in. They go through the same repository and
 * audit code as the REST routes.
 */

export interface FeatureChoice {
  id: string;
  key: string;
  title: string;
  lifecycle_status: string;
  milestone_id: string | null;
}
export interface MilestoneChoice {
  id: string;
  name: string;
  status: string;
  target_date: string | null;
}

export async function listFeatureChoices(db: DbLike, projectId: string): Promise<FeatureChoice[]> {
  const r = await sql<FeatureChoice>`
    SELECT id::text AS id, key, title, lifecycle_status, milestone_id::text AS milestone_id
    FROM features WHERE project_id = ${projectId}::uuid AND deleted_at IS NULL ORDER BY key
  `.execute(db as never);
  return r.rows;
}

export async function listMilestoneChoices(db: DbLike, projectId: string, includeClosed = true): Promise<MilestoneChoice[]> {
  const r = await sql<MilestoneChoice>`
    SELECT id::text AS id, name, status, target_date::text AS target_date
    FROM milestones WHERE project_id = ${projectId}::uuid AND deleted_at IS NULL
      AND (${includeClosed} OR status = 'open')
    ORDER BY name
  `.execute(db as never);
  return r.rows;
}

const short = (list: string[]): string => (list.length ? list.slice(0, 20).join(', ') : 'none');

/**
 * Resolve `feature_ref` (id, key in any letter case, or an exact unique title) and `milestone_ref` (id or an
 * exact unique name) to ids. A miss lists what exists, so an agent can correct itself instead of guessing.
 */
export async function resolveWorkItemLinks(
  db: DbLike,
  projectId: string,
  refs: { featureRef?: string; milestoneRef?: string },
): Promise<{ feature_id: string | null; milestone_id: string | null }> {
  let feature_id: string | null = null;
  let milestone_id: string | null = null;
  if (refs.featureRef) {
    const typed = refs.featureRef.trim();
    const all = await listFeatureChoices(db, projectId);
    const direct = all.filter((f) => f.id === typed || f.key.toLowerCase() === typed.toLowerCase());
    const byTitle = direct.length ? direct : all.filter((f) => f.title.toLowerCase() === typed.toLowerCase());
    if (byTitle.length === 1) feature_id = byTitle[0].id;
    else if (byTitle.length > 1) {
      throw new AppError('VALIDATION_ERROR', `feature '${typed}' matches ${byTitle.length} features: ${short(byTitle.map((f) => `${f.key} (${f.title})`))}`, {
        matches: byTitle,
        needed_action: 'pass the feature key or id of the one you mean',
      });
    } else {
      throw new AppError('NOT_FOUND', `no feature '${typed}' in this project. Features: ${short(all.map((f) => `${f.key} (${f.title})`))}`, {
        ref: typed,
        available: all.slice(0, 20).map((f) => ({ key: f.key, title: f.title })),
        needed_action: 'pass a feature key or id from available, or create one with ledger_feature_create',
      });
    }
  }
  if (refs.milestoneRef) {
    const typed = refs.milestoneRef.trim();
    const all = await listMilestoneChoices(db, projectId);
    const direct = all.filter((m) => m.id === typed);
    const matches = direct.length ? direct : all.filter((m) => m.name.toLowerCase() === typed.toLowerCase());
    if (matches.length === 1) milestone_id = matches[0].id;
    else if (matches.length > 1) {
      throw new AppError('VALIDATION_ERROR', `milestone '${typed}' matches ${matches.length} milestones: ${short(matches.map((m) => `${m.name} (${m.id})`))}`, {
        matches,
        needed_action: 'pass the milestone id of the one you mean',
      });
    } else {
      throw new AppError('NOT_FOUND', `no milestone '${typed}' in this project. Milestones: ${short(all.map((m) => m.name))}`, {
        ref: typed,
        available: all.slice(0, 20).map((m) => ({ name: m.name, status: m.status })),
        needed_action: 'pass a milestone name or id from available, or create one with ledger_milestone_create',
      });
    }
  }
  return { feature_id, milestone_id };
}

// ---- tools -------------------------------------------------------------------------------------------------

export const featuresToolSchema = z.strictObject({ project_ref: projectRefSchema.optional() });
export const milestonesToolSchema = z.strictObject({
  project_ref: projectRefSchema.optional(),
  include_closed: z.boolean().default(true).describe('Also list closed milestones (default true).'),
});
export const featureCreateToolSchema = z.strictObject({
  project_ref: projectRefSchema.optional(),
  key: featureSchema.shape.key.describe('Short unique feature key in the project, for example AUTH. Letters and digits, at most 16 characters.'),
  title: featureSchema.shape.title.describe('Feature title.'),
  description: z.string().max(50_000).optional().describe('What the feature is for.'),
  milestone_ref: z.string().min(1).max(200).optional().describe('Milestone id or exact unique name to attach the feature to.'),
  acceptance_criteria: z.array(z.string().min(1).max(1000)).max(50).optional().describe('Plain-text criteria for the feature; they start unticked.'),
});
export const milestoneCreateToolSchema = z.strictObject({
  project_ref: projectRefSchema.optional(),
  name: milestoneSchema.shape.name.describe('Milestone name, unique in the project.'),
  target_date: z.string().date().optional().describe('Target date as YYYY-MM-DD.'),
});

export async function ledgerFeaturesTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const args = parseTool<{ project_ref?: string }>(featuresToolSchema, raw, 'send {} or { project_ref }');
  const projectId = await resolveProject(db, actor, args.project_ref, 'project:read');
  return { project_id: projectId, items: await listFeatureChoices(db, projectId) };
}

export async function ledgerMilestonesTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const args = parseTool<{ project_ref?: string; include_closed: boolean }>(milestonesToolSchema, raw, 'send {} or { project_ref, include_closed }');
  const projectId = await resolveProject(db, actor, args.project_ref, 'project:read');
  return { project_id: projectId, items: await listMilestoneChoices(db, projectId, args.include_closed) };
}

export async function ledgerFeatureCreateTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const args = parseTool<z.infer<typeof featureCreateToolSchema>>(featureCreateToolSchema, raw, 'send { key, title } and optionally description, milestone_ref, acceptance_criteria');
  const projectId = await resolveProject(db, actor, args.project_ref, 'project:write');
  const existing = (await listFeatureChoices(db, projectId)).find((f) => f.key.toLowerCase() === args.key.toLowerCase());
  if (existing) {
    throw new AppError('CONFLICT', `feature key '${args.key}' already exists in this project (${existing.title})`, {
      existing: { id: existing.id, key: existing.key, title: existing.title },
      needed_action: 'use feature_ref with that key, or pick a different key',
    });
  }
  const links = await resolveWorkItemLinks(db, projectId, { milestoneRef: args.milestone_ref });
  let featureId = '';
  await unitOfWork(db, async ({ tx }) => {
    // The features module is imported through its service only (plan §3) and has none, so the insert is
    // written here with the same columns as the REST route's repository call.
    featureId = newId();
    await tx
      .insertInto('features')
      .values({
        id: featureId,
        organization_id: actor.organizationId,
        project_id: projectId,
        key: args.key,
        title: args.title,
        description: args.description ?? null,
        target_release: null,
        milestone_id: links.milestone_id,
        acceptance_criteria: toJsonb((args.acceptance_criteria ?? []).map((text) => ({ text, done: false }))) as never,
      })
      .execute();
    await recordAudit(tx, {
      organization_id: actor.organizationId,
      actor_type: actor.type === 'agent' ? 'agent' : 'user',
      actor_id: actor.id,
      action: 'feature.create',
      resource_type: 'feature',
      resource_id: featureId,
      summary: { project_id: projectId, key: args.key, title: args.title, via: 'ledger_feature_create' },
      request_id: actor.requestId,
    });
  });
  return { id: featureId, key: args.key, title: args.title, milestone_id: links.milestone_id, project_id: projectId };
}

export async function ledgerMilestoneCreateTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const args = parseTool<z.infer<typeof milestoneCreateToolSchema>>(milestoneCreateToolSchema, raw, 'send { name } and optionally target_date');
  const projectId = await resolveProject(db, actor, args.project_ref, 'project:write');
  const existing = (await listMilestoneChoices(db, projectId)).find((m) => m.name.toLowerCase() === args.name.toLowerCase());
  if (existing) {
    throw new AppError('CONFLICT', `milestone '${args.name}' already exists in this project`, {
      existing,
      needed_action: 'use milestone_ref with that name, or pick a different name',
    });
  }
  const id = await createMilestone(db, actor, projectId, args.name, args.target_date ?? null, 'open');
  return { id, name: args.name, target_date: args.target_date ?? null, status: 'open', project_id: projectId };
}

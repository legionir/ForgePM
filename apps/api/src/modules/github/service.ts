import { AppError } from '@forgepm/shared';
import {
  newId,
  unitOfWork,
  recordAudit,
  getEffective,
  applyPullRequestEvent,
  type PullRequestEventData,
  type Db,
  type DbLike,
} from '@forgepm/core';
import type { Actor } from '../../app/auth-context';
import { assertProjectAccess } from '../projects/access';

export interface RepoRow {
  id: string;
  organization_id: string;
  external_id: string;
  full_name: string;
  installation_id: string | null;
  default_branch: string | null;
}

const REPO_COLS = ['id', 'organization_id', 'external_id', 'full_name', 'installation_id', 'default_branch'] as const;

/** Upsert a repository from a webhook/API payload (by provider external_id). */
export async function upsertRepository(
  db: DbLike,
  orgId: string,
  input: { external_id: string; full_name: string; installation_id?: string | null; default_branch?: string | null },
): Promise<string> {
  const existing = await db
    .selectFrom('repositories')
    .select('id')
    .where('provider', '=', 'github')
    .where('external_id', '=', input.external_id)
    .executeTakeFirst();
  if (existing) {
    await db
      .updateTable('repositories')
      .set({ full_name: input.full_name, installation_id: input.installation_id ?? null, default_branch: input.default_branch ?? null } as never)
      .where('id', '=', existing.id)
      .execute();
    return existing.id;
  }
  const id = newId();
  await db
    .insertInto('repositories')
    .values({
      id,
      organization_id: orgId,
      provider: 'github',
      external_id: input.external_id,
      full_name: input.full_name,
      installation_id: input.installation_id ?? null,
      default_branch: input.default_branch ?? null,
    })
    .execute();
  return id;
}

export async function listRepositories(db: DbLike, orgId: string): Promise<RepoRow[]> {
  const rows = await db.selectFrom('repositories').select(REPO_COLS).where('organization_id', '=', orgId).orderBy('full_name').execute();
  return rows as unknown as RepoRow[];
}

/** Repositories linked to one project (drives the panel's connected / not-connected indicator). */
export async function listProjectRepositories(db: DbLike, actor: Actor, projectId: string): Promise<RepoRow[]> {
  await assertProjectAccess(db, actor, projectId, 'project:read');
  const rows = await db
    .selectFrom('project_repositories as pr')
    .innerJoin('repositories as r', 'r.id', 'pr.repository_id')
    .select(['r.id', 'r.organization_id', 'r.external_id', 'r.full_name', 'r.installation_id', 'r.default_branch'])
    .where('pr.project_id', '=', projectId)
    .where('pr.organization_id', '=', actor.organizationId)
    .orderBy('r.full_name')
    .execute();
  return rows as unknown as RepoRow[];
}

/**
 * Remove the project <-> repository link. Only the join row goes (D-069): the repository,
 * its pull requests and issue links stay, and reconnecting restores the link. Idempotent;
 * an audit event is written only when a link actually existed.
 */
export async function disconnectRepoFromProject(db: Db, actor: Actor, projectId: string, repositoryId: string): Promise<boolean> {
  await assertProjectAccess(db, actor, projectId, 'project:write');
  let removed = false;
  await unitOfWork(db, async ({ tx }) => {
    const res = await tx
      .deleteFrom('project_repositories')
      .where('project_id', '=', projectId)
      .where('repository_id', '=', repositoryId)
      .where('organization_id', '=', actor.organizationId)
      .executeTakeFirst();
    removed = Number(res.numDeletedRows) > 0;
    if (!removed) return;
    await recordAudit(tx, {
      organization_id: actor.organizationId,
      actor_type: actor.type === 'agent' ? 'agent' : 'user',
      actor_id: actor.id,
      action: 'github.disconnect_repository',
      resource_type: 'project',
      resource_id: projectId,
      summary: { repository_id: repositoryId },
      request_id: actor.requestId,
    });
  });
  return removed;
}

export async function connectRepoToProject(db: Db, actor: Actor, projectId: string, repositoryId: string): Promise<void> {
  await assertProjectAccess(db, actor, projectId, 'project:write');
  const repo = await db.selectFrom('repositories').select('id').where('id', '=', repositoryId).where('organization_id', '=', actor.organizationId).executeTakeFirst();
  if (!repo) throw new AppError('NOT_FOUND', 'repository not found');
  await unitOfWork(db, async ({ tx }) => {
    await tx
      .insertInto('project_repositories')
      .values({ project_id: projectId, repository_id: repositoryId, organization_id: actor.organizationId })
      .onConflict((oc) => oc.columns(['project_id', 'repository_id']).doNothing())
      .execute();
    await recordAudit(tx, {
      organization_id: actor.organizationId,
      actor_type: actor.type === 'agent' ? 'agent' : 'user',
      actor_id: actor.id,
      action: 'github.connect_repository',
      resource_type: 'project',
      resource_id: projectId,
      summary: { repository_id: repositoryId },
      request_id: actor.requestId,
    });
  });
}

/** A pull-request webhook payload (subset we persist; no source code). */
export type PullRequestEvent = PullRequestEventData;

/**
 * Process a pull_request event via the SHARED core implementation, so the api
 * (manual link) and the worker (webhook job) apply identical logic. The
 * auto-transition gate reads the project setting at processing time.
 */
export async function processPullRequest(db: Db, orgId: string, ev: PullRequestEvent): Promise<{ links: number; transitions: number }> {
  return applyPullRequestEvent(db, orgId, ev, async (projectId) => {
    return (await getEffective(db, 'github.auto_transition_on_merge', orgId, projectId))?.value === true;
  });
}

/** Development tab: PRs/commits/branches linked to a work item. */
export async function developmentFor(db: DbLike, orgId: string, itemId: string): Promise<unknown[]> {
  const ok = await db.selectFrom('work_items').select('id').where('id', '=', itemId).where('organization_id', '=', orgId).executeTakeFirst();
  if (!ok) throw new AppError('NOT_FOUND', 'work item not found');
  const links = await db
    .selectFrom('work_item_external_links')
    .select(['kind', 'external_id', 'url', 'metadata'])
    .where('work_item_id', '=', itemId)
    .execute();
  return links;
}

/**
 * One-way GitHub Issue import — delegates to the shared core implementation so
 * the api (manual) and worker (webhook) run identical logic (plan §9.5).
 */
export { importIssueEvent as importIssue, type IssueEventData } from '@forgepm/core';



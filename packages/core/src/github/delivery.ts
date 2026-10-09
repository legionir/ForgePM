import { sql } from 'kysely';
import { newId } from '../id';
import { toJsonb } from '../jsonb';
import { getEffective } from '../settings';
import { recordAudit } from '../audit';
import type { DbLike } from '../db/unitOfWork';

/**
 * GitHub delivery processing (plan §9) — placed in core so BOTH the api
 * (manual link) and the worker (webhook job) apply the exact same logic
 * through one code path (single writer, no cross-app imports). It is actor
 * free: webhook processing runs as the `system` actor and writes its own
 * audit rows via `applyPullRequestEvent`'s caller.
 */
export interface PullRequestEventData {
  action: string;
  repository_external_id: string;
  repository_full_name: string;
  pr_external_id: string;
  number: number;
  title: string;
  state: string;
  draft: boolean;
  author?: string | null;
  head_sha?: string | null;
  body?: string | null;
  head_ref?: string | null;
  merged?: boolean;
  merged_at?: string | null;
}

/** Normalise a raw GitHub `pull_request` webhook payload to our event shape. */
export function normalizePullRequestPayload(payload: Record<string, unknown>): PullRequestEventData | null {
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  const repo = payload.repository as Record<string, unknown> | undefined;
  if (!pr || !repo) return null;
  return {
    action: (payload.action as string) ?? 'opened',
    repository_external_id: String(repo.id ?? ''),
    repository_full_name: (repo.full_name as string) ?? '',
    pr_external_id: String(pr.id ?? ''),
    number: Number(pr.number ?? 0),
    title: (pr.title as string) ?? '',
    state: (pr.state as string) ?? 'open',
    draft: !!pr.draft,
    author: ((pr.user as { login?: string } | undefined)?.login) ?? null,
    head_sha: ((pr.head as { sha?: string } | undefined)?.sha) ?? null,
    body: (pr.body as string) ?? null,
    head_ref: ((pr.head as { ref?: string } | undefined)?.ref) ?? null,
    merged: !!pr.merged,
    merged_at: (pr.merged_at as string) ?? null,
  };
}

export function extractItemKeys(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(/\b([A-Z]{2,5})-(\d+)\b/g)) out.add(`${m[1]}-${m[2]}`);
  return [...out];
}

export function extractClosingKeys(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(closes|closed|fixes|fixed|resolves|resolved|close|fix|resolve)\s+([A-Z]{2,5})-(\d+)\b/gi)) {
    out.add(`${m[2].toUpperCase()}-${m[3]}`);
  }
  return [...out];
}

async function upsertRepo(db: DbLike, orgId: string, externalId: string, fullName: string): Promise<string> {
  const existing = await db.selectFrom('repositories').select('id').where('provider', '=', 'github').where('external_id', '=', externalId).executeTakeFirst();
  if (existing) {
    await db.updateTable('repositories').set({ full_name: fullName } as never).where('id', '=', existing.id).execute();
    return existing.id;
  }
  const id = newId();
  await db.insertInto('repositories').values({ id, organization_id: orgId, provider: 'github', external_id: externalId, full_name: fullName }).execute();
  return id;
}

export { upsertRepo };

/**
 * One-way GitHub Issue import (plan §9.5), shared by api (manual import) and
 * the worker (webhook). Only `off`/`import` do anything. Idempotent via
 * external_issue_links. A locally-edited item is not overwritten — instead a
 * `github.sync_conflict` audit is written. Returns the action taken.
 */
export interface IssueEventData {
  repository_external_id: string;
  repository_full_name: string;
  issue_number: number;
  title: string;
  body: string | null;
  state: string;
  labels: string[];
  remote_version?: string | null;
}

export async function importIssueEvent(
  db: DbLike,
  orgId: string,
  projectId: string,
  issue: IssueEventData,
  systemActorId: string,
): Promise<'created' | 'updated' | 'conflict' | 'skipped'> {
  const mode = (await getEffective(db, 'github.issue_sync_mode', orgId, projectId))?.value;
  if (mode !== 'import') return 'skipped';
  const repoId = await upsertRepo(db, orgId, issue.repository_external_id, issue.repository_full_name);

  const link = await db
    .selectFrom('external_issue_links')
    .select(['work_item_id', 'last_synced_at', 'local_modified_at'])
    .where('repository_id', '=', repoId)
    .where('issue_number', '=', issue.issue_number)
    .executeTakeFirst();

  if (!link) {
    const state = await db.selectFrom('workflow_states').select('id').where('project_id', '=', projectId).where('category', '=', 'unstarted').limit(1).executeTakeFirst();
    const projRow = await db.selectFrom('projects').select('next_item_number').where('id', '=', projectId).executeTakeFirst();
    const num = Number(projRow?.next_item_number ?? 1);
    const wiId = newId();
    await db.transaction().execute(async (tx) => {
      await tx
        .insertInto('work_items')
        .values({ id: wiId, organization_id: orgId, project_id: projectId, number: num, type: 'bug', title: issue.title.slice(0, 500), description: issue.body, state_id: state?.id ?? newId(), source: 'github' })
        .execute();
      await tx
        .insertInto('external_issue_links')
        .values({ id: newId(), work_item_id: wiId, repository_id: repoId, issue_number: issue.issue_number, remote_version: issue.remote_version ?? null, last_synced_at: new Date() })
        .execute();
      await tx.updateTable('projects').set({ next_item_number: num + 1, updated_at: new Date() } as never).where('id', '=', projectId).execute();
      await recordAudit(tx, { organization_id: orgId, actor_type: 'system', actor_id: systemActorId, action: 'github.issue_import', resource_type: 'work_item', resource_id: wiId, summary: { issue_number: issue.issue_number, created: true }, request_id: null });
    });
    return 'created';
  }

  const item = await db.selectFrom('work_items').select('id').where('id', '=', link.work_item_id).where('deleted_at', 'is', null).executeTakeFirst();
  if (!item) return 'skipped';
  if (link.local_modified_at && link.last_synced_at && new Date(link.local_modified_at) > new Date(link.last_synced_at)) {
    await recordAudit(db, { organization_id: orgId, actor_type: 'system', actor_id: systemActorId, action: 'github.sync_conflict', resource_type: 'work_item', resource_id: item.id, summary: { issue_number: issue.issue_number }, request_id: null });
    return 'conflict';
  }
  const cat = issue.state === 'closed' ? 'completed' : 'unstarted';
  const st = await db.selectFrom('workflow_states').select('id').where('project_id', '=', projectId).where('category', '=', cat).limit(1).executeTakeFirst();
  await db.updateTable('work_items').set({ title: issue.title.slice(0, 500), description: issue.body, ...(st ? { state_id: st.id } : {}), updated_at: new Date() } as never).where('id', '=', item.id).execute();
  await db
    .updateTable('external_issue_links')
    .set({ last_synced_at: new Date(), remote_version: issue.remote_version ?? null } as never)
    .where('repository_id', '=', repoId)
    .where('issue_number', '=', issue.issue_number)
    .execute();
  await recordAudit(db, { organization_id: orgId, actor_type: 'system', actor_id: systemActorId, action: 'github.issue_import', resource_type: 'work_item', resource_id: item.id, summary: { issue_number: issue.issue_number, updated: true }, request_id: null });
  return 'updated';
}

/** Normalize a raw GitHub `issues` payload to IssueEventData. */
export function normalizeIssuePayload(payload: Record<string, unknown>): { repository_external_id: string; repository_full_name: string; issue: IssueEventData } | null {
  const issue = payload.issue as Record<string, unknown> | undefined;
  const repo = payload.repository as Record<string, unknown> | undefined;
  if (!issue || !repo) return null;
  const labels = Array.isArray(issue.labels) ? (issue.labels as { name?: string }[]).map((l) => l.name ?? '').filter(Boolean) : [];
  return {
    repository_external_id: String(repo.id ?? ''),
    repository_full_name: (repo.full_name as string) ?? '',
    issue: {
      repository_external_id: String(repo.id ?? ''),
      repository_full_name: (repo.full_name as string) ?? '',
      issue_number: Number(issue.number ?? 0),
      title: (issue.title as string) ?? '',
      body: (issue.body as string) ?? null,
      state: (issue.state as string) ?? 'open',
      labels,
      remote_version: (issue.updated_at as string) ?? null,
    },
  };
}

/** Persist a release event (plan §9.6). Returns whether it was new. */
export async function recordRelease(db: DbLike, orgId: string, repo: { external_id: string; full_name: string }, tag: string, publishedAt: string | null, notes: string | null): Promise<{ repoId: string; created: boolean }> {
  const repoId = await upsertRepo(db, orgId, repo.external_id, repo.full_name);
  const existing = await db.selectFrom('releases').select('id').where('repository_id', '=', repoId).where('tag', '=', tag).executeTakeFirst();
  if (existing) return { repoId, created: false };
  await db.insertInto('releases').values({ id: newId(), repository_id: repoId, tag, published_at: publishedAt ? new Date(publishedAt) : null, notes_ref: notes }).execute();
  return { repoId, created: true };
}


async function upsertPr(db: DbLike, repoId: string, ev: PullRequestEventData): Promise<void> {
  const existing = await db.selectFrom('pull_requests').select('id').where('repository_id', '=', repoId).where('external_id', '=', ev.pr_external_id).executeTakeFirst();
  const set = {
    title: ev.title,
    state: ev.state,
    draft: ev.draft,
    author: ev.author ?? null,
    head_sha: ev.head_sha ?? null,
    body: ev.body ?? null,
    merged_at: ev.merged_at ? new Date(ev.merged_at) : null,
    updated_at: new Date(),
  };
  if (existing) {
    await db.updateTable('pull_requests').set(set as never).where('id', '=', existing.id).execute();
  } else {
    await db
      .insertInto('pull_requests')
      .values({ id: newId(), repository_id: repoId, external_id: ev.pr_external_id, number: ev.number, ...set, created_at: new Date() } as never)
      .execute();
  }
}

/**
 * Apply a normalized PR event: repo + PR upsert, link work items by extracted
 * keys, and (when `github.auto_transition_on_merge`) transition `closes KEY`
 * items to completed on merge. Returns counts for the delivery log.
 */
export async function applyPullRequestEvent(
  db: DbLike,
  orgId: string,
  ev: PullRequestEventData,
  autoTransition: (projectId: string) => Promise<boolean>,
): Promise<{ links: number; transitions: number }> {
  const repoId = await upsertRepo(db, orgId, ev.repository_external_id, ev.repository_full_name);
  await upsertPr(db, repoId, ev);

  const projectIds = (await db.selectFrom('project_repositories').select('project_id').where('repository_id', '=', repoId).where('organization_id', '=', orgId).execute()).map((r) => r.project_id);

  let links = 0;
  let transitions = 0;
  const keys = new Set<string>([...extractItemKeys(ev.head_ref), ...extractItemKeys(ev.title), ...extractItemKeys(ev.body)]);
  const closing = new Set(ev.action === 'closed' && ev.merged ? extractClosingKeys(`${ev.title}\n${ev.body ?? ''}`) : []);

  for (const pid of projectIds) {
    for (const key of keys) {
      const num = Number(/-(\d+)$/.exec(key)?.[1]);
      if (Number.isNaN(num)) continue;
      const item = await db.selectFrom('work_items').select(['id', 'project_id']).where('project_id', '=', pid).where('number', '=', num).where('deleted_at', 'is', null).executeTakeFirst();
      if (!item) continue;
      await db
        .insertInto('work_item_external_links')
        .values({ id: newId(), work_item_id: item.id, kind: 'pr', external_id: ev.pr_external_id, url: `https://github.com/${ev.repository_full_name}/pull/${ev.number}`, metadata: toJsonb({ number: ev.number, state: ev.state }) as never })
        .onConflict((oc) => oc.columns(['work_item_id', 'kind', 'external_id']).doNothing())
        .execute();
      links++;
      if (closing.has(key) && (await autoTransition(pid))) {
        const done = await db.selectFrom('workflow_states').select('id').where('project_id', '=', pid).where('category', '=', 'completed').limit(1).executeTakeFirst();
        if (done) {
          await db.updateTable('work_items').set({ state_id: done.id, updated_at: new Date() } as never).where('id', '=', item.id).execute();
          transitions++;
        }
      }
    }
  }
  return { links, transitions };
}

/** Mark a webhook delivery processed; returns whether it was still pending. */
export async function markDeliveryDone(db: DbLike, deliveryId: string): Promise<void> {
  await db
    .updateTable('webhook_deliveries')
    .set({ status: 'done', processed_at: new Date() } as never)
    .where('delivery_id', '=', deliveryId)
    .where('status', 'in', ['received', 'processing'])
    .execute();
}

export async function deliveryRow(db: DbLike, deliveryId: string): Promise<{ organization_id: string; event: string; payload: unknown; status: string } | undefined> {
  const rows = await sql<{ organization_id: string; event: string; payload: unknown; status: string }>`
    SELECT organization_id, event, payload, status FROM webhook_deliveries WHERE delivery_id = ${deliveryId}
  `.execute(db);
  return rows.rows[0];
}

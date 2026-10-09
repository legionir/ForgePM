import { sql } from 'kysely';
import { AppError } from '@forgepm/shared';
import { newId } from '../id';
import { toJsonb } from '../jsonb';
import { recordAudit } from '../audit';
import { getEffective } from '../settings';
import type { Db, DbLike } from '../db/unitOfWork';
import { SEVERITY_ORDER, computeFingerprint, type RawFinding, type ReviewConfig } from './contract';

/**
 * Finding persistence (plan §10). One table, one engine for both modules:
 *  - UNIQUE(project_id, scope_key, fingerprint): a rerun of the same scope
 *    updates last_seen_run_id instead of creating a duplicate.
 *  - status lifecycle: open → not_seen (missed one complete run) → fixed
 *    (missed 2 consecutive complete runs, or a human confirms). Truncated or
 *    failed runs never advance the unseen counter. Being seen again → open.
 */

export interface FindingWrite {
  raw: RawFinding;
  fingerprint: string;
}

export function fingerprintFor(projectId: string, f: RawFinding): string {
  return computeFingerprint({ projectId, category: f.category, file: f.file, title: f.title, evidence: f.evidence ?? null });
}

export interface UpsertResult {
  created: number;
  updated: number;
  ids: string[];
}

/** Insert-or-touch findings for a completed (non-truncated) run. */
export async function upsertFindings(
  db: Db,
  args: {
    organizationId: string;
    projectId: string;
    runId: string;
    scopeKey: string;
    findings: RawFinding[];
  },
): Promise<UpsertResult> {
  let created = 0;
  let updated = 0;
  const ids: string[] = [];
  for (const f of args.findings) {
    const fp = fingerprintFor(args.projectId, f);
    const existing = await db
      .selectFrom('review_findings')
      .select(['id', 'status'])
      .where('project_id', '=', args.projectId)
      .where('scope_key', '=', args.scopeKey)
      .where('fingerprint', '=', fp)
      .executeTakeFirst();
    if (existing) {
      // seen again → back to open (unless a human closed it), last_seen advances.
      await db
        .updateTable('review_findings')
        .set({
          last_seen_run_id: args.runId,
          run_id: args.runId,
          status: existing.status === 'dismissed' || existing.status === 'fixed' || existing.status === 'issue_created' ? existing.status : 'open',
          unseen_streak: 0,
          confidence: f.confidence,
          severity: f.severity,
          line_start: f.line_start ?? null,
          line_end: f.line_end ?? null,
          updated_at: new Date(),
        } as never)
        .where('id', '=', existing.id)
        .execute();
      ids.push(existing.id);
      updated++;
      continue;
    }
    const id = newId();
    await db
      .insertInto('review_findings')
      .values({
        id,
        organization_id: args.organizationId,
        project_id: args.projectId,
        run_id: args.runId,
        first_run_id: args.runId,
        last_seen_run_id: args.runId,
        scope_key: args.scopeKey,
        fingerprint: fp,
        category: f.category,
        severity: f.severity,
        confidence: f.confidence,
        file: f.file,
        line_start: f.line_start ?? null,
        line_end: f.line_end ?? null,
        title: f.title,
        description: f.description,
        why_it_matters: f.why_it_matters ?? null,
        suggestion: f.suggestion ?? null,
        evidence: f.evidence ?? null,
        impact: f.impact ?? null,
        effort: f.effort ?? null,
        risk: f.risk ?? null,
        status: 'open',
        unseen_streak: 0,
      } as never)
      .execute();
    ids.push(id);
    created++;
  }
  return { created, updated, ids };
}

/**
 * After a COMPLETE run in the same scope, findings not seen in it go
 * open/accepted → not_seen (streak 1) → fixed (streak ≥ 2). Only open-ish
 * statuses participate; dismissed / issue_created are human-owned terminal.
 * `truncated`/failed runs must not call this.
 */
export async function sweepNotSeen(db: Db, args: { projectId: string; scopeKey: string; runId: string }): Promise<{ not_seen: number; fixed: number }> {
  const missed = await db
    .selectFrom('review_findings')
    .select(['id', 'status', 'unseen_streak'])
    .where('project_id', '=', args.projectId)
    .where('scope_key', '=', args.scopeKey)
    .where('last_seen_run_id', '!=', args.runId)
    .where('status', 'in', ['open', 'accepted', 'not_seen'])
    .execute();
  let notSeen = 0;
  let fixed = 0;
  for (const f of missed) {
    const streak = Number(f.unseen_streak ?? 0) + 1;
    const status = streak >= 2 ? 'fixed' : 'not_seen';
    if (status === 'fixed') fixed++;
    else notSeen++;
    await db
      .updateTable('review_findings')
      .set({ status, unseen_streak: streak, updated_at: new Date() } as never)
      .where('id', '=', f.id)
      .execute();
  }
  return { not_seen: notSeen, fixed };
}

/** auto_high_severity eligibility (plan §10): severity ≥ high + kind confidence floor. */
export function shouldCreateWorkItem(f: RawFinding, kind: 'code' | 'refactor', config: ReviewConfig): boolean {
  if (config.issue_policy !== 'auto_high_severity') return false;
  if (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER.high) return false;
  const floor = kind === 'code' ? 0.8 : 0.85;
  return f.confidence >= floor;
}

export interface FindingRow {
  id: string;
  organization_id: string;
  project_id: string;
  run_id: string;
  scope_key: string;
  fingerprint: string;
  category: string;
  severity: string;
  confidence: number;
  file: string;
  line_start: number | null;
  line_end: number | null;
  title: string;
  description: string;
  why_it_matters: string | null;
  suggestion: string | null;
  evidence: string | null;
  impact: string | null;
  effort: string | null;
  risk: string | null;
  status: string;
  work_item_id: string | null;
}

const FINDING_COLS = [
  'id', 'organization_id', 'project_id', 'run_id', 'scope_key', 'fingerprint', 'category', 'severity',
  'confidence', 'file', 'line_start', 'line_end', 'title', 'description', 'why_it_matters', 'suggestion',
  'evidence', 'impact', 'effort', 'risk', 'status', 'work_item_id',
] as const;

export async function loadFinding(db: DbLike, organizationId: string, id: string): Promise<FindingRow> {
  const r = await db
    .selectFrom('review_findings')
    .select(FINDING_COLS)
    .where('id', '=', id)
    .where('organization_id', '=', organizationId)
    .executeTakeFirst();
  if (!r) throw new AppError('NOT_FOUND', 'finding not found');
  const row = r as unknown as FindingRow;
  row.confidence = Number(row.confidence);
  return row;
}

/**
 * Create a WorkItem from a finding (plan §10 issue policy). Idempotent per
 * finding: a second call returns the existing item (`issue_created` +
 * work_item_id set atomically under a partial unique guard). For
 * `human_approval` an approved approval_request carrying this finding_id is
 * required first. Every creation is a transactional domain+audit write.
 */
export async function createWorkItemFromFinding(
  db: Db,
  args: {
    organizationId: string;
    findingId: string;
    actorType: 'user' | 'agent' | 'system';
    actorId: string;
    requestId: string | null;
    approvedApprovalExists?: boolean;
  },
): Promise<{ work_item_id: string; replayed: boolean }> {
  const f = await loadFinding(db, args.organizationId, args.findingId);
  if (f.work_item_id) return { work_item_id: f.work_item_id, replayed: true };
  if (f.status === 'dismissed') throw new AppError('CONFLICT', 'finding is dismissed');
  if (args.approvedApprovalExists === false) throw new AppError('FORBIDDEN', 'finding requires an approved approval request');

  const run = await db.selectFrom('review_runs').select(['kind', 'project_id']).where('id', '=', f.run_id).executeTakeFirstOrThrow();
  const type = run.kind === 'code' ? 'bug' : 'refactor';
  const source = run.kind === 'code' ? 'code_review' : 'refactor_review';

  const state = await db
    .selectFrom('workflow_states')
    .select('id')
    .where('project_id', '=', f.project_id)
    .where('category', '=', 'unstarted')
    .limit(1)
    .executeTakeFirst();
  const proj = await db.selectFrom('projects').select('next_item_number').where('id', '=', f.project_id).executeTakeFirstOrThrow();
  const num = Number(proj.next_item_number);
  const wiId = newId();
  const issueTitle = `[${f.severity}] ${f.title}`.slice(0, 500);
  const body = [f.description, f.why_it_matters && `\nWhy it matters: ${f.why_it_matters}`, f.suggestion && `\nSuggestion: ${f.suggestion}`, `\n${f.file}${f.line_start ? `:${f.line_start}` : ''} (finding ${f.id})`].filter(Boolean).join('');

  await db.transaction().execute(async (tx) => {
    await tx
      .insertInto('work_items')
      .values({
        id: wiId,
        organization_id: args.organizationId,
        project_id: f.project_id,
        number: num,
        type,
        title: issueTitle,
        description: body,
        state_id: state?.id ?? newId(),
        acceptance_criteria: toJsonb({ finding_id: f.id, file: f.file, line_start: f.line_start, line_end: f.line_end, suggestion: f.suggestion }) as never,
        source,
      })
      .execute();
    await tx.updateTable('projects').set({ next_item_number: num + 1, updated_at: new Date() } as never).where('id', '=', f.project_id).execute();
    // `agent-ready` label so an external agent can pick refactor items via MCP.
    const label = await tx.selectFrom('labels').select('id').where('project_id', '=', f.project_id).where('name', '=', 'agent-ready').executeTakeFirst();
    const labelId = label?.id ?? newId();
    if (!label) {
      await tx.insertInto('labels').values({ id: labelId, organization_id: args.organizationId, project_id: f.project_id, name: 'agent-ready', color: '#0969da' }).execute();
    }
    await tx.insertInto('work_item_labels').values({ work_item_id: wiId, label_id: labelId }).execute();
    await tx
      .updateTable('review_findings')
      .set({ status: 'issue_created', work_item_id: wiId, updated_at: new Date() } as never)
      .where('id', '=', f.id)
      .execute();
    await recordAudit(tx, {
      organization_id: args.organizationId,
      actor_type: args.actorType,
      actor_id: args.actorId,
      action: `review.create_work_item.${source}`,
      resource_type: 'review_finding',
      resource_id: f.id,
      summary: { work_item_id: wiId, type },
      request_id: args.requestId,
    });
  });
  return { work_item_id: wiId, replayed: false };
}

/** Dismiss / accept a finding with reason + actor (plan §10). */
export async function updateFindingStatus(
  db: Db,
  args: {
    organizationId: string;
    findingId: string;
    status: 'dismissed' | 'accepted' | 'open';
    reason?: string;
    actorType: 'user' | 'agent';
    actorId: string;
    requestId: string | null;
  },
): Promise<void> {
  const f = await loadFinding(db, args.organizationId, args.findingId);
  if (args.status === 'dismissed' && !args.reason) throw new AppError('VALIDATION_ERROR', 'dismiss requires a reason');
  await db.transaction().execute(async (tx) => {
    await tx.updateTable('review_findings').set({ status: args.status, updated_at: new Date() } as never).where('id', '=', f.id).execute();
    await recordAudit(tx, {
      organization_id: args.organizationId,
      actor_type: args.actorType,
      actor_id: args.actorId,
      action: `review.finding.${args.status}`,
      resource_type: 'review_finding',
      resource_id: f.id,
      summary: { reason: args.reason ?? null },
      request_id: args.requestId,
    });
  });
}

/**
 * Queue a `review.create_work_item` approval request for a finding
 * (issue_policy = human_approval). UNIQUE via payload finding_id + status
 * pending is enforced here by a pre-check; deciding it approves creation.
 */
export async function requestFindingApproval(db: DbLike, orgId: string, projectId: string, findingId: string, requestedBy: string): Promise<string> {
  const existing = await db
    .selectFrom('approval_requests')
    .select('id')
    .where('organization_id', '=', orgId)
    .where('action', '=', 'review.create_work_item')
    .where('status', '=', 'pending')
    .where(sql`payload->>'finding_id'`, '=', findingId)
    .executeTakeFirst();
  if (existing) return existing.id;
  const id = newId();
  await db
    .insertInto('approval_requests')
    .values({
      id,
      organization_id: orgId,
      project_id: projectId,
      requested_by: requestedBy,
      action: 'review.create_work_item',
      payload: JSON.parse(JSON.stringify({ finding_id: findingId })),
      risk: 'sensitive',
      status: 'pending',
    })
    .execute();
  return id;
}

export async function hasApprovedFindingRequest(db: DbLike, orgId: string, findingId: string): Promise<boolean> {
  const r = await db
    .selectFrom('approval_requests')
    .select('id')
    .where('organization_id', '=', orgId)
    .where('action', '=', 'review.create_work_item')
    .where('status', '=', 'approved')
    .where(sql`payload->>'finding_id'`, '=', findingId)
    .executeTakeFirst();
  return !!r;
}

/** Effective issue policy for a project (shared registry; one source). */
export async function effectiveIssuePolicy(db: DbLike, orgId: string, projectId: string): Promise<ReviewConfig['issue_policy']> {
  return ((await getEffective(db as Db, 'review.issue_policy', orgId, projectId))?.value as ReviewConfig['issue_policy']) ?? 'record_only';
}

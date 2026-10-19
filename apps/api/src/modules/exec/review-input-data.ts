import { sql } from 'kysely';
import {
  evaluateScope,
  evidenceIsVerifiable,
  loadLedgerStatus,
  type Db,
  type ExecReviewSnapshot,
  type ReviewInputParts,
} from '@forgepm/core';

export interface TaskRow {
  id: string;
  organization_id: string;
  project_id: string;
  code: string;
  title: string;
  status: string;
  start_ref: string | null;
  allowed_paths: unknown;
}

interface RequirementRow {
  id: string;
  code: string;
  text: string;
  quote: string;
  source: string;
  status: string;
}

interface CriteriaRow {
  id: string;
  req_id: string | null;
  code: string;
  text: string;
  status: string;
}

interface EvidenceRow {
  criterion_id: string | null;
  kind: string;
  ref: string;
  summary: string;
  payload: string | null;
  sha256: string | null;
}

export async function findReviewTask(
  db: Db,
  organizationId: string,
  projectId: string,
  ref: string,
): Promise<TaskRow | undefined> {
  const result = await sql<TaskRow>`
    SELECT id::text AS id, organization_id::text AS organization_id, project_id::text AS project_id,
           code, title, status, start_ref, allowed_paths
    FROM exec_tasks
    WHERE organization_id = ${organizationId}::uuid AND project_id = ${projectId}::uuid
      AND (id::text = ${ref} OR code = ${ref})
    LIMIT 1
  `.execute(db as never);
  return result.rows[0];
}

export async function loadReviewParts(
  db: Db,
  organizationId: string,
  projectId: string,
  task: TaskRow,
  snapshot: ExecReviewSnapshot,
): Promise<ReviewInputParts> {
  const [requirements, criteria, evidence, ledgerResult, report] = await Promise.all([
    db.selectFrom('exec_requirements')
      .select(['id', 'code', 'text', 'quote', 'source', 'status'])
      .where('organization_id', '=', organizationId)
      .where((eb) => eb('project_id', '=', projectId).or('project_id', 'is', null))
      .where('status', '!=', 'dropped')
      .orderBy('code')
      .execute() as Promise<RequirementRow[]>,
    db.selectFrom('exec_criteria')
      .select(['id', 'req_id', 'code', 'text', 'status'])
      .where('task_id', '=', task.id)
      .orderBy('code')
      .execute() as Promise<CriteriaRow[]>,
    db.selectFrom('exec_evidence')
      .select(['criterion_id', 'kind', 'ref', 'summary', 'payload', 'sha256'])
      .where('task_id', '=', task.id)
      .orderBy('created_at')
      .execute() as Promise<EvidenceRow[]>,
    loadLedgerStatus(db, { organizationId, projectId }, task.code),
    db.selectFrom('exec_reports')
      .select('payload')
      .where('task_id', '=', task.id)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst(),
  ]);
  const evidenceByCriterion = new Map<string, EvidenceRow[]>();
  for (const row of evidence) {
    if (!row.criterion_id) continue;
    const list = evidenceByCriterion.get(row.criterion_id) ?? [];
    list.push(row);
    evidenceByCriterion.set(row.criterion_id, list);
  }
  const criteriaInput = criteria.map((criterion) => ({
    code: criterion.code,
    text: criterion.text,
    status: criterion.status,
    evidence: (evidenceByCriterion.get(criterion.id) ?? []).map((row) => ({
      ref: row.ref,
      kind: row.kind,
      ok: evidenceIsVerifiable({ ref: row.ref, payload: row.payload, sha256: row.sha256 }),
    })),
  }));
  const requirementCriteria = new Map<string, string[]>();
  for (const criterion of criteria) {
    if (!criterion.req_id) continue;
    const list = requirementCriteria.get(criterion.req_id) ?? [];
    list.push(criterion.code);
    requirementCriteria.set(criterion.req_id, list);
  }
  const activeRequirements = requirements.filter((requirement) => requirement.status !== 'dropped');
  const scopeVerdict = evaluateScope(
    Array.isArray(task.allowed_paths) ? (task.allowed_paths as string[]) : [],
    snapshot.files.map((file) => ({ path: file.path, status: file.change })),
    true,
  );
  const ledger = ledgerResult.tasks[0] ?? { available: false, needed_action: ledgerResult.needed_action };
  return {
    user_request: activeRequirements
      .filter((requirement) => requirement.source === 'user_message')
      .map((requirement) => ({ code: requirement.code, text: requirement.text, quote: requirement.quote })),
    criteria: criteriaInput,
    requirements: activeRequirements.map((requirement) => ({
      code: requirement.code,
      text: requirement.text,
      covered_by: requirementCriteria.get(requirement.id) ?? [],
    })),
    diff: snapshot.files,
    ledger_status: ledger,
    exit_report: report?.payload ?? null,
    scope_verdict: scopeVerdict,
  };
}

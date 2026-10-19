import { sql } from 'kysely';
import type { DbLike } from '../db/unitOfWork';
import type { LedgerActor } from './open-items-service';
import type { RequirementCoverageRow } from './requirement-types';

export async function requirementCoverage(
  db: DbLike,
  actor: Pick<LedgerActor, 'organizationId' | 'projectId'>,
): Promise<{ requirements: RequirementCoverageRow[]; unassigned: string[]; total: number }> {
  const [requirements, declarations, criteria] = await Promise.all([
    sql<{ id: string; code: string; text: string; status: string }>`
      SELECT id::text AS id, code, text, status FROM exec_requirements
      WHERE organization_id = ${actor.organizationId}::uuid
        AND (project_id = ${actor.projectId}::uuid OR project_id IS NULL)
      ORDER BY code
    `.execute(db as never),
    sql<{ task_id: string; task_code: string; req_ids: unknown }>`
      SELECT t.id::text AS task_id, t.code AS task_code, e.payload #> '{after,req_ids}' AS req_ids
      FROM exec_tasks t JOIN exec_events e ON e.task_id = t.id
      WHERE t.organization_id = ${actor.organizationId}::uuid AND t.project_id = ${actor.projectId}::uuid
        AND e.action = 'task.created'
      ORDER BY t.code
    `.execute(db as never),
    sql<{ req_id: string; task_code: string; criterion: string; status: string; evidence_count: number }>`
      SELECT c.req_id::text AS req_id, t.code AS task_code, c.code AS criterion, c.status,
             count(e.id)::int AS evidence_count
      FROM exec_criteria c JOIN exec_tasks t ON t.id = c.task_id
      LEFT JOIN exec_evidence e ON e.criterion_id = c.id
      WHERE t.organization_id = ${actor.organizationId}::uuid AND t.project_id = ${actor.projectId}::uuid
        AND c.req_id IS NOT NULL
      GROUP BY c.req_id, t.code, c.code, c.status ORDER BY t.code, c.code
    `.execute(db as never),
  ]);
  const byRef = new Map<string, string>();
  for (const requirement of requirements.rows) {
    byRef.set(requirement.id, requirement.id);
    byRef.set(requirement.code, requirement.id);
  }
  const assignments = new Map<string, Set<string>>();
  for (const event of declarations.rows) {
    for (const ref of stringArray(event.req_ids)) {
      const reqId = byRef.get(ref);
      if (reqId) addAssignment(assignments, reqId, event.task_code);
    }
  }
  const linkedByReq = new Map<string, RequirementCoverageRow['linked_criteria']>();
  for (const row of criteria.rows) {
    const linked = linkedByReq.get(row.req_id) ?? [];
    linked.push({ task: row.task_code, criterion: row.criterion, status: row.status, evidence_count: row.evidence_count });
    linkedByReq.set(row.req_id, linked);
    addAssignment(assignments, row.req_id, row.task_code);
  }
  const rows = requirements.rows.map((requirement): RequirementCoverageRow => {
    const assigned = [...(assignments.get(requirement.id) ?? [])].sort();
    const linked = linkedByReq.get(requirement.id) ?? [];
    const covered = linked.length > 0 && linked.every((item) => item.status === 'verified' && item.evidence_count > 0);
    return {
      id: requirement.id,
      code: requirement.code,
      text: requirement.text,
      status: requirement.status,
      assignment_tasks: assigned,
      linked_criteria: linked,
      coverage: coverageStatus(requirement.status, assigned.length, linked.length, covered),
    };
  });
  return {
    requirements: rows,
    unassigned: rows.filter((row) => row.coverage === 'unassigned').map((row) => row.code),
    total: rows.length,
  };
}

function addAssignment(assignments: Map<string, Set<string>>, reqId: string, taskCode: string): void {
  const tasks = assignments.get(reqId) ?? new Set<string>();
  tasks.add(taskCode);
  assignments.set(reqId, tasks);
}

function coverageStatus(
  status: string,
  assigned: number,
  linked: number,
  covered: boolean,
): RequirementCoverageRow['coverage'] {
  if (status === 'dropped') return 'dropped';
  if (covered) return 'covered';
  if (linked) return 'in_progress';
  return assigned ? 'assigned' : 'unassigned';
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

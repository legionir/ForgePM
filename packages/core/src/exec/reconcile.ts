import { sql } from 'kysely';
import { resolveExecReviewSource } from './review-source';
import { diffScopeManifest, makeScopeManifest, restrictScopeManifest, type ChangedFile, type ScopeFileManifest } from './scope';
import type { DbLike } from '../db/unitOfWork';
import type { LedgerActor } from './open-items-service';

const MAX_TASKS = 500;
const MAX_REPORTED_PATHS = 250;
const MAX_SUMMARY_ROWS = 200;

export interface ReconcileResult {
  project_id: string;
  reconciled_at: string;
  completed_task_drift: {
    task_id: string;
    task_code: string;
    closed_at: string | null;
    changed_count: number;
    changed_files: ChangedFile[];
    truncated: boolean;
  }[];
  unmeasurable_closed_tasks: { task_id: string; task_code: string; reason: string }[];
  missing_gate_stamp: { task_id: string; task_code: string; reason: string }[];
  stale_facts: { code: string; key: string; source: string; files: string[] }[];
  unsettled_journal: { code: string; task_code: string; action: string; status: string; idempotent: boolean }[];
  changed_file_diffs: {
    task_id: string;
    task_code: string;
    measured_count: number;
    reported_count: number;
    measured_not_reported: string[];
    reported_not_measured: string[];
    matches: boolean;
    truncated: boolean;
    measurement_error?: string;
  }[];
  counts: Record<string, number>;
  truncated: boolean;
}

interface TaskReconcileRow {
  id: string;
  code: string;
  status: string;
  start_ref: string | null;
  closed_at: Date | null;
  gate_id: string | null;
  gate_ok: boolean | null;
  gate_file_manifest: unknown;
  report_payload: unknown;
}

/**
 * Read-side reconciliation for appendix K.4. Close-time file hashes are stored
 * on the append-only gate stamp; current Git input is measured by the server's
 * read-only adapter. Report.changed_files is compared for drift only and is
 * never a source for scope or a gate decision.
 */
export async function reconcileLedger(db: DbLike, actor: Pick<LedgerActor, 'organizationId' | 'projectId'>): Promise<ReconcileResult> {
  const [tasksResult, factsResult, journalResult] = await Promise.all([
    sql<TaskReconcileRow>`
      SELECT t.id::text AS id, t.code, t.status, t.start_ref, t.closed_at,
        g.id::text AS gate_id, g.ok AS gate_ok, g.file_manifest AS gate_file_manifest,
        r.payload AS report_payload
      FROM exec_tasks t
      LEFT JOIN exec_gate_checks g ON g.id = t.gate_stamp_id
      LEFT JOIN LATERAL (
        SELECT payload FROM exec_reports WHERE task_id = t.id
        ORDER BY created_at DESC, id DESC LIMIT 1
      ) r ON true
      WHERE t.organization_id = ${actor.organizationId}::uuid
        AND t.project_id = ${actor.projectId}::uuid
      ORDER BY t.updated_at DESC, t.code
      LIMIT ${MAX_TASKS + 1}
    `.execute(db as never),
    sql<{ code: string; key: string; source: string; files: unknown }>`
      SELECT code, key, source, files FROM exec_facts
      WHERE organization_id = ${actor.organizationId}::uuid
        AND project_id = ${actor.projectId}::uuid AND status = 'stale'
      ORDER BY code LIMIT ${MAX_SUMMARY_ROWS + 1}
    `.execute(db as never),
    sql<{ code: string; task_code: string; action: string; status: string; idempotent: boolean }>`
      SELECT j.code, t.code AS task_code, j.action, j.status, j.idempotent
      FROM exec_action_journal j JOIN exec_tasks t ON t.id = j.task_id
      WHERE t.organization_id = ${actor.organizationId}::uuid
        AND t.project_id = ${actor.projectId}::uuid AND j.status IN ('started','unknown')
      ORDER BY CASE WHEN j.status = 'unknown' THEN 0 ELSE 1 END, j.started_at, j.code
      LIMIT ${MAX_SUMMARY_ROWS + 1}
    `.execute(db as never),
  ]);

  const tasks = tasksResult.rows.slice(0, MAX_TASKS);
  const source = resolveExecReviewSource();
  const manifestCache = new Map<string, Promise<ScopeFileManifest>>();
  const completedTaskDrift: ReconcileResult['completed_task_drift'] = [];
  const unmeasurableClosedTasks: ReconcileResult['unmeasurable_closed_tasks'] = [];
  const missingGateStamp: ReconcileResult['missing_gate_stamp'] = [];
  const changedFileDiffs: ReconcileResult['changed_file_diffs'] = [];
  let truncated = tasksResult.rows.length > MAX_TASKS || factsResult.rows.length > MAX_SUMMARY_ROWS || journalResult.rows.length > MAX_SUMMARY_ROWS;

  for (const task of tasks) {
    if (task.status === 'done') {
      if (!task.gate_id || task.gate_ok !== true) {
        missingGateStamp.push({
          task_id: task.id,
          task_code: task.code,
          reason: task.gate_id ? 'the task points at a non-passing gate stamp' : 'the task has no gate stamp',
        });
      } else {
        const saved = parseCloseManifest(task.gate_file_manifest);
        if (!saved) {
          unmeasurableClosedTasks.push({
            task_id: task.id,
            task_code: task.code,
            reason: 'the passing gate stamp has no valid hash-only close snapshot',
          });
        } else if (!source?.fileSnapshot) {
          unmeasurableClosedTasks.push({
            task_id: task.id,
            task_code: task.code,
            reason: 'no read-only per-file hash source is configured',
          });
        } else {
          const rootsKey = JSON.stringify([saved.roots, saved.allowed_paths]);
          let currentPromise = manifestCache.get(rootsKey);
          if (!currentPromise) {
            currentPromise = source.fileSnapshot({ roots: saved.roots }).then((manifest) => restrictScopeManifest(manifest, saved.allowed_paths));
            manifestCache.set(rootsKey, currentPromise);
          }
          try {
            const current = await currentPromise;
            const changes = diffScopeManifest(saved.manifest, current);
            if (changes.length) {
              completedTaskDrift.push({
                task_id: task.id,
                task_code: task.code,
                closed_at: task.closed_at?.toISOString() ?? null,
                changed_count: changes.length,
                changed_files: changes.slice(0, MAX_REPORTED_PATHS),
                truncated: changes.length > MAX_REPORTED_PATHS,
              });
            }
          } catch {
            unmeasurableClosedTasks.push({
              task_id: task.id,
              task_code: task.code,
              reason: 'the current read-only file snapshot could not be measured safely',
            });
          }
        }
      }
    }

    const payload = asObject(task.report_payload);
    const reported = stringArray(payload?.changed_files);
    if (!task.start_ref || !Array.isArray(payload?.changed_files)) continue;
    if (!source?.changedFiles) {
      changedFileDiffs.push({
        task_id: task.id,
        task_code: task.code,
        measured_count: 0,
        reported_count: reported.length,
        measured_not_reported: [],
        reported_not_measured: reported.slice(0, MAX_REPORTED_PATHS),
        matches: false,
        truncated: reported.length > MAX_REPORTED_PATHS,
        measurement_error: 'no read-only Git diff source is configured',
      });
      continue;
    }
    try {
      const measured = await source.changedFiles({ start_ref: task.start_ref });
      const measuredPaths = [...new Set(measured.map((file) => file.path))].sort();
      const reportedPaths = [...new Set(reported)].sort();
      const measuredSet = new Set(measuredPaths);
      const reportedSet = new Set(reportedPaths);
      const measuredNotReported = measuredPaths.filter((path) => !reportedSet.has(path));
      const reportedNotMeasured = reportedPaths.filter((path) => !measuredSet.has(path));
      if (measuredNotReported.length || reportedNotMeasured.length) {
        changedFileDiffs.push({
          task_id: task.id,
          task_code: task.code,
          measured_count: measuredPaths.length,
          reported_count: reportedPaths.length,
          measured_not_reported: measuredNotReported.slice(0, MAX_REPORTED_PATHS),
          reported_not_measured: reportedNotMeasured.slice(0, MAX_REPORTED_PATHS),
          matches: false,
          truncated: measuredNotReported.length > MAX_REPORTED_PATHS || reportedNotMeasured.length > MAX_REPORTED_PATHS,
        });
      }
    } catch {
      changedFileDiffs.push({
        task_id: task.id,
        task_code: task.code,
        measured_count: 0,
        reported_count: reported.length,
        measured_not_reported: [],
        reported_not_measured: reported.slice(0, MAX_REPORTED_PATHS),
        matches: false,
        truncated: reported.length > MAX_REPORTED_PATHS,
        measurement_error: 'the read-only Git diff could not be measured safely',
      });
    }
  }

  const staleFacts = factsResult.rows.slice(0, MAX_SUMMARY_ROWS).map((fact) => ({
    code: fact.code,
    key: fact.key,
    source: fact.source,
    files: stringArray(fact.files),
  }));
  const unsettledJournal = journalResult.rows.slice(0, MAX_SUMMARY_ROWS);
  const result: ReconcileResult = {
    project_id: actor.projectId,
    reconciled_at: new Date().toISOString(),
    completed_task_drift: completedTaskDrift,
    unmeasurable_closed_tasks: unmeasurableClosedTasks,
    missing_gate_stamp: missingGateStamp,
    stale_facts: staleFacts,
    unsettled_journal: unsettledJournal,
    changed_file_diffs: changedFileDiffs,
    counts: {
      tasks_examined: tasks.length,
      completed_task_drift: completedTaskDrift.length,
      unmeasurable_closed_tasks: unmeasurableClosedTasks.length,
      missing_gate_stamp: missingGateStamp.length,
      stale_facts: factsResult.rows.length,
      unsettled_journal: journalResult.rows.length,
      changed_file_diffs: changedFileDiffs.length,
    },
    truncated,
  };
  return result;
}

function parseCloseManifest(raw: unknown): { roots: string[]; allowed_paths: string[]; manifest: ScopeFileManifest } | null {
  const value = asObject(raw);
  const roots = stringArray(value?.roots);
  const allowedPaths = stringArray(value?.allowed_paths);
  if (!value || !roots.length || !allowedPaths.length || !Array.isArray(value.files)) return null;
  try {
    const manifest = makeScopeManifest(
      value.files.map((entry) => {
        const file = asObject(entry);
        if (!file || typeof file.path !== 'string' || typeof file.sha256 !== 'string') throw new Error('invalid file hash');
        return { path: file.path, sha256: file.sha256 };
      }),
    );
    if (typeof value.hash === 'string' && value.hash !== manifest.hash) return null;
    return { roots, allowed_paths: allowedPaths, manifest };
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
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

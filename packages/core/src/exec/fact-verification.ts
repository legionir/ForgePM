import { sql } from 'kysely';
import { AppError } from '@forgepm/shared';
import { recordAudit, SYSTEM_ACTOR_ID } from '../audit';
import type { DbLike } from '../db/unitOfWork';
import { makeScopeManifest, type ScopeFileManifest, type ScopeManifestFile } from './scope';
import { appendEvent } from './events';
import { createOpenItem, type LedgerActor } from './open-items-service';
import { allowedRoots } from './fact-evidence';
import type { ExecFactFileSource } from './review-source';

interface StoredFact {
  id: string;
  code: string;
  key: string;
  status: 'active' | 'stale';
  files: unknown;
  file_hashes: unknown;
}

export interface FactVerificationPreparation {
  rows: StoredFact[];
  manifest: ScopeFileManifest | null;
  unavailable_reason: string | null;
  explicit: boolean;
}

export interface FactVerificationChange {
  id: string;
  code: string;
  from: string;
  to: string;
  changed_files: string[];
  warning?: string;
}

export interface FactVerificationResult {
  checked: number;
  changes: FactVerificationChange[];
}

/** Read paths and hashes before opening the mutation transaction. */
export async function prepareFactVerification(
  db: DbLike,
  actor: Pick<LedgerActor, 'organizationId' | 'projectId'>,
  source: ExecFactFileSource | null,
  factRef?: string,
): Promise<FactVerificationPreparation> {
  let rows: StoredFact[];
  if (factRef) {
    const selected = await sql<StoredFact>`
      SELECT id::text AS id, code, key, status, files, file_hashes
      FROM exec_facts
      WHERE organization_id = ${actor.organizationId}::uuid AND project_id = ${actor.projectId}::uuid
        AND (code = ${factRef} OR id::text = ${factRef})
      LIMIT 1
    `.execute(db as never);
    const fact = selected.rows[0];
    if (!fact) throw new AppError('NOT_FOUND', `no fact '${factRef}' in this project`, { ref: factRef });
    if (fact.status !== 'active' && fact.status !== 'stale') {
      throw new AppError('LEDGER_STATE_INVALID', `fact ${fact.code} is ${fact.status}`, {
        needed_action: 'only an active or stale fact can be verified; rejected and superseded facts remain history',
      });
    }
    rows = [fact];
  } else {
    const selected = await sql<StoredFact>`
      SELECT id::text AS id, code, key, status, files, file_hashes
      FROM exec_facts
      WHERE organization_id = ${actor.organizationId}::uuid AND project_id = ${actor.projectId}::uuid
        AND status = 'active'
      ORDER BY code
    `.execute(db as never);
    rows = selected.rows.filter((row) => readStringArray(row.files).length > 0);
  }
  if (!rows.length) return { rows, manifest: makeScopeManifest([]), unavailable_reason: null, explicit: !!factRef };

  const files = [...new Set(rows.flatMap((row) => readStringArray(row.files)))].sort();
  if (!files.length) {
    return { rows, manifest: null, unavailable_reason: 'fact has no file paths to verify', explicit: !!factRef };
  }
  const roots = await allowedRoots(db, actor);
  if (!roots.length) {
    return { rows, manifest: null, unavailable_reason: 'exec.allowed_repo_roots is empty', explicit: !!factRef };
  }
  if (!source?.hashFiles && !source?.fileSnapshot) {
    return { rows, manifest: null, unavailable_reason: 'no read-only file-hash source is configured', explicit: !!factRef };
  }

  try {
    if (source.hashFiles) {
      const manifest = await source.hashFiles({ roots, files, allowMissing: true });
      return { rows, manifest, unavailable_reason: null, explicit: !!factRef };
    }
    const all = await source.fileSnapshot!({ roots });
    const wanted = new Set(files);
    const manifest = makeScopeManifest(all.files.filter((file) => wanted.has(file.path)));
    return { rows, manifest, unavailable_reason: null, explicit: !!factRef };
  } catch (error) {
    return {
      rows,
      manifest: null,
      unavailable_reason: safeMessage(error) || 'fact files could not be measured safely',
      explicit: !!factRef,
    };
  }
}

/**
 * Compare stored hashes and materialize stale consequences in the caller's
 * transaction. Automatic checks only demote; explicit verification may restore
 * the fact, but never silently reactivates its dependent decisions.
 */
export async function applyFactVerification(
  db: DbLike,
  actor: LedgerActor,
  prepared: FactVerificationPreparation,
): Promise<FactVerificationResult> {
  const changes: FactVerificationChange[] = [];
  for (const fact of prepared.rows) {
    const files = readStringArray(fact.files);
    const expected = readHashEntries(fact.file_hashes);
    const actual = new Map((prepared.manifest?.files ?? []).map((file) => [file.path, file.sha256]));
    const changed = prepared.unavailable_reason
      ? files
      : files.filter((path) => !expected.has(path) || !actual.has(path) || expected.get(path) !== actual.get(path));
    const matches = !prepared.unavailable_reason && files.length > 0 && changed.length === 0;

    if (!matches) {
      if (fact.status === 'active') {
        const updated = await sql<{ id: string }>`
          UPDATE exec_facts SET status = 'stale'
          WHERE id = ${fact.id}::uuid AND status = 'active'
          RETURNING id::text AS id
        `.execute(db as never);
        if (updated.rows[0]) {
          await appendEvent(db, {
            organization_id: actor.organizationId,
            task_id: null,
            entity: 'fact',
            entity_id: fact.id,
            entity_code: fact.code,
            action: 'fact.stale',
            actor_type: actor.actorType,
            actor_id: actor.actorId,
            tool: actor.tool ?? null,
            payload: {
              before: { status: 'active' },
              after: { status: 'stale', changed_files: changed, reason: prepared.unavailable_reason },
            },
          });
          changes.push({
            id: fact.id,
            code: fact.code,
            from: 'active',
            to: 'stale',
            changed_files: changed,
            ...(prepared.unavailable_reason ? { warning: prepared.unavailable_reason } : {}),
          });
        }
      }
      await flagFactDependentsForRevisit(
        db,
        actor,
        fact,
        prepared.unavailable_reason ?? `source hashes changed: ${changed.join(', ')}`,
      );
      if (prepared.explicit) {
        await appendEvent(db, {
          organization_id: actor.organizationId,
          task_id: null,
          entity: 'fact',
          entity_id: fact.id,
          entity_code: fact.code,
          action: 'fact.verification_failed',
          actor_type: actor.actorType,
          actor_id: actor.actorId,
          tool: actor.tool ?? 'fact_verify',
          payload: { status: 'stale', changed_files: changed, reason: prepared.unavailable_reason },
        });
        if (fact.status === 'stale') {
          changes.push({
            id: fact.id,
            code: fact.code,
            from: 'stale',
            to: 'stale',
            changed_files: changed,
            warning: prepared.unavailable_reason ?? 'stored source hashes do not match the current files',
          });
        }
      }
      continue;
    }

    if (!prepared.explicit) continue;
    const updated = await sql<{ id: string }>`
      UPDATE exec_facts SET status = 'active', verified_at = now()
      WHERE id = ${fact.id}::uuid AND status IN ('active','stale')
      RETURNING id::text AS id
    `.execute(db as never);
    if (!updated.rows[0]) continue;
    await appendEvent(db, {
      organization_id: actor.organizationId,
      task_id: null,
      entity: 'fact',
      entity_id: fact.id,
      entity_code: fact.code,
      action: 'fact.verified',
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      tool: actor.tool ?? 'fact_verify',
      payload: { before: { status: fact.status }, after: { status: 'active', files } },
    });
    changes.push({ id: fact.id, code: fact.code, from: fact.status, to: 'active', changed_files: [] });
  }
  return { checked: prepared.rows.length, changes };
}

/** Move linked active decisions to needs_revisit and add one blocker per task. */
export async function flagFactDependentsForRevisit(
  db: DbLike,
  actor: LedgerActor,
  fact: { id: string; code: string },
  reason: string,
): Promise<string[]> {
  const linked = await sql<{ id: string; code: string; task_id: string; task_code: string }>`
    SELECT d.id::text AS id, d.code, d.task_id::text AS task_id, t.code AS task_code
    FROM exec_fact_decisions fd
    JOIN exec_decisions d ON d.id = fd.decision_id
    JOIN exec_tasks t ON t.id = d.task_id
    WHERE fd.fact_id = ${fact.id}::uuid AND d.organization_id = ${actor.organizationId}::uuid
      AND t.project_id = ${actor.projectId}::uuid AND d.status = 'active'
    ORDER BY t.code, d.code
    FOR UPDATE OF d
  `.execute(db as never);
  if (!linked.rows.length) return [];

  const ids = linked.rows.map((row) => row.id);
  await sql`
    UPDATE exec_decisions SET status = 'needs_revisit', updated_at = now()
    WHERE id = ANY(${ids}::uuid[]) AND status = 'active'
  `.execute(db as never);
  for (const decision of linked.rows) {
    await appendEvent(db, {
      organization_id: actor.organizationId,
      task_id: decision.task_id,
      entity: 'decision',
      entity_id: decision.id,
      entity_code: decision.code,
      action: 'decision.needs_revisit',
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      tool: actor.tool ?? null,
      payload: { before: { status: 'active' }, after: { status: 'needs_revisit', fact: fact.code, reason } },
    });
    await recordAudit(db, {
      organization_id: actor.organizationId,
      actor_type: actor.actorType === 'human' ? 'user' : actor.actorType,
      actor_id: actor.actorId,
      action: 'exec.fact.decision_revisit',
      resource_type: 'exec_decision',
      resource_id: decision.id,
      summary: { code: decision.code, fact: fact.code, reason },
    });
  }

  const byTask = new Map<string, { code: string; decisions: string[] }>();
  for (const decision of linked.rows) {
    const group = byTask.get(decision.task_id) ?? { code: decision.task_code, decisions: [] };
    group.decisions.push(decision.code);
    byTask.set(decision.task_id, group);
  }
  const blockers: string[] = [];
  const systemActor: LedgerActor = {
    organizationId: actor.organizationId,
    projectId: actor.projectId,
    actorType: 'system',
    actorId: SYSTEM_ACTOR_ID,
    tool: actor.tool ?? 'fact_verify',
  };
  for (const [taskId, group] of byTask) {
    const listed = group.decisions.slice(0, 6).join(', ');
    const suffix = group.decisions.length > 6 ? `, and ${group.decisions.length - 6} more` : '';
    const title = `fact ${fact.code} changed; revisit ${listed}${suffix}`.slice(0, 500);
    const detail = `The source evidence for fact ${fact.code} is no longer current (${reason}). Dependent decision(s) ${group.decisions.join(', ')} were marked needs_revisit. Verify the fact and record a fresh decision before relying on it.`.slice(0, 8000);
    try {
      const item = await createOpenItem(
        db,
        systemActor,
        group.code,
        {
          title,
          detail,
          type: 'risk',
          blocks_completion: true,
          related_ref: `fact-stale:${fact.id}:${taskId}`,
        },
        'hook',
      );
      await recordAudit(db, {
        organization_id: actor.organizationId,
        actor_type: actor.actorType === 'human' ? 'user' : actor.actorType,
        actor_id: actor.actorId,
        action: 'exec.fact.blocker.create',
        resource_type: 'exec_open_item',
        resource_id: item.id,
        summary: { code: item.code, task: group.code, fact: fact.code, decisions: group.decisions },
      });
      blockers.push(item.code);
    } catch (error) {
      if (error instanceof AppError && error.code === 'CONFLICT') continue;
      throw error;
    }
  }
  return blockers;
}

function readStringArray(value: unknown): string[] {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? [...new Set(raw.filter((entry): entry is string => typeof entry === 'string'))] : [];
}

function readHashEntries(value: unknown): Map<string, string> {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return new Map();
    }
  }
  if (!Array.isArray(raw)) return new Map();
  const entries: ScopeManifestFile[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.path === 'string' && typeof record.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(record.sha256)) {
      entries.push({ path: record.path, sha256: record.sha256.toLowerCase() });
    }
  }
  return new Map(entries.map((entry) => [entry.path, entry.sha256]));
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 400) : '';
}

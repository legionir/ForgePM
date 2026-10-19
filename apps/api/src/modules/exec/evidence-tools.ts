import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evidenceObjectSchema, evidenceRefinement } from '@forgepm/shared';
import { addEvidence, loadEvidenceDeps, unitOfWork, type Db, type EvidenceFsLike } from '@forgepm/core';
import type { Actor } from '../../app/auth-context';
import { auditIn, ledgerActor, parseTool, projectForTask, projectRefSchema } from './context';

/**
 * `ledger_add_evidence` (plan §9.1, acceptance B.10/B.16).
 *
 * "A claim without proof is forbidden" is a write-time rule, so the tool
 * READS what it is asked to record: a path that does not exist is refused
 * (`EVIDENCE_UNAVAILABLE`), a path outside `exec.allowed_repo_roots` is a
 * scope violation, and a test log without a result line is a paraphrase. The
 * service does the reading; this file only says WHERE the bytes come from.
 */

/** The tool's own shape: the shared payload plus the API-level project. */
export const evidenceToolSchema = evidenceObjectSchema
  .extend({
    project_ref: projectRefSchema.optional(),
  })
  .superRefine(evidenceRefinement);

/**
 * The server's own disk, relative to the working directory the operator runs
 * the API from. The roots in `exec.allowed_repo_roots` are relative paths, and
 * `underRoot` (in the core) refuses absolute paths and `..` — so a ref can
 * only name a file under a root the operator opened on purpose.
 */
export const repoFs: EvidenceFsLike = {
  exists: (path) => existsSync(resolve(process.cwd(), path)),
  read: (path) => {
    try {
      return readFileSync(resolve(process.cwd(), path), 'utf8');
    } catch {
      return null;
    }
  },
};

export async function addEvidenceTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const tool = parseTool<{
    task_ref: string;
    criterion_ref?: string;
    kind: 'test_output' | 'diff' | 'file' | 'command_output' | 'manual_check';
    ref: string;
    summary: string;
    payload?: string;
    project_ref?: string;
  }>(
    evidenceToolSchema,
    raw,
    'send { task_ref, kind, ref, summary } — ref is a pointer an auditor can read, summary says what was observed',
  );
  const projectId = await projectForTask(db, actor, tool.task_ref, tool.project_ref);
  const deps = await loadEvidenceDeps(db, actor.organizationId, projectId, repoFs);
  // `project_ref` is an API-level field: the ledger payload is strict, so it
  // is rebuilt here from the known keys rather than spread through.
  const payload = {
    task_ref: tool.task_ref,
    criterion_ref: tool.criterion_ref,
    kind: tool.kind,
    ref: tool.ref,
    summary: tool.summary,
    payload: tool.payload,
  };
  let out: unknown;
  await unitOfWork(db, async ({ tx }) => {
    const row = await addEvidence(tx, ledgerActor(actor, projectId, 'ledger_add_evidence'), payload, deps);
    await auditIn(tx, actor, 'exec.evidence.add', 'exec_evidence', row.id, {
      task: row.task_code,
      criterion: row.criterion_code,
      kind: row.kind,
      ref: row.ref,
      verified: row.verified,
      redacted: row.redacted,
    });
    out = row;
  });
  return out;
}

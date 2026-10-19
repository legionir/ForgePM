import { sql } from 'kysely';
import { AppError, evidenceInputSchema } from '@forgepm/shared';
import type { DbLike } from '../db/unitOfWork';
import { newId } from '../id';
import { toJsonb } from '../jsonb';
import { getEffective } from '../settings';
import { appendEvent } from './events';
import { checkEvidence, redactSecrets, type EvidenceFsLike, type EvidenceKind } from './evidence';
import { findTaskByRef, type LedgerActor } from './open-items-service';

/**
 * `ledger_add_evidence` (plan §9.1, acceptance B.10/B.16) — "a claim without
 * proof is forbidden".
 *
 * The write path is deliberately narrow:
 *
 *   1. the payload is shape-checked (strict — an unknown key is refused),
 *   2. the ref is READ. A path that does not exist is not evidence, a path
 *      outside `exec.allowed_repo_roots` is a scope violation, and a test log
 *      without a result line is a paraphrase, not output,
 *   3. secrets are masked BEFORE anything is written,
 *   4. the row, the criterion's verification and the event commit together.
 *
 * The caller owns the transaction: pass a `unitOfWork` tx so the evidence, the
 * criterion and the event roll back together.
 */

export interface EvidenceAddValue {
  task_ref: string;
  criterion_ref?: string;
  kind: EvidenceKind;
  ref: string;
  summary: string;
  payload?: string;
}

export interface EvidenceAddResult {
  id: string;
  task_code: string;
  criterion_code: string | null;
  kind: string;
  ref: string;
  summary: string;
  sha256: string | null;
  size_bytes: number | null;
  /** The criterion is verified by this evidence. */
  verified: boolean;
  /** How many secrets were masked before writing. */
  redacted: number;
  meta: Record<string, unknown>;
}

/** The knobs the service needs from the operator (settings + the real disk). */
export interface EvidenceDeps {
  fs: EvidenceFsLike;
  roots: string[];
  maxBytes: number;
  parser?: { pass: string[]; fail: string[]; skip: string[] };
}

export interface EvidenceAddOutcome {
  ok: true;
  value: EvidenceAddValue;
}
export interface EvidenceAddFailure {
  ok: false;
  code: 'UNPROCESSABLE';
  message: string;
  needed_action: string;
}
export type EvidenceAddParse = EvidenceAddOutcome | EvidenceAddFailure;

export function parseEvidenceAdd(raw: unknown): EvidenceAddParse {
  const parsed = evidenceInputSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path?.length ? issue.path.join('.') : 'payload';
    return {
      ok: false,
      code: 'UNPROCESSABLE',
      message: `${path}: ${issue?.message ?? 'the evidence payload did not parse'}`,
      needed_action:
        'send { task_ref, kind, ref, summary } — ref is a pointer an auditor can read (file:<path> | commit:<sha>:<path> | ci:<run>:<job> | test:<name> | cmd:<id>), and summary says what was observed',
    };
  }
  return { ok: true, value: parsed.data as EvidenceAddValue };
}

export async function addEvidence(
  db: DbLike,
  actor: LedgerActor,
  raw: unknown,
  deps: EvidenceDeps,
): Promise<EvidenceAddResult> {
  const parsed = parseEvidenceAdd(raw);
  if (!parsed.ok) {
    throw new AppError(parsed.code, parsed.message, { needed_action: parsed.needed_action });
  }
  const input = parsed.value;

  const task = await findTaskByRef(db, actor, input.task_ref);
  if (!task) throw new AppError('NOT_FOUND', `no task '${input.task_ref}' in this project`, { ref: input.task_ref });

  const criterion = input.criterion_ref ? await findCriterion(db, task.id, input.criterion_ref) : null;
  if (input.criterion_ref && !criterion) {
    throw new AppError('NOT_FOUND', `no criterion '${input.criterion_ref}' on task ${task.code}`, {
      ref: input.criterion_ref,
      needed_action: 'criterion_ref must be a criterion of the task (by code, e.g. C-001)',
    });
  }

  const checked = checkEvidence({
    kind: input.kind,
    ref: input.ref,
    summary: input.summary,
    payload: input.payload,
    actorType: actor.actorType,
    parser: deps.parser,
    roots: deps.roots,
    fs: deps.fs,
    maxBytes: deps.maxBytes,
  });
  if (!checked.ok) {
    throw new AppError(checked.code ?? 'EVIDENCE_INVALID', checked.message ?? 'the evidence did not verify', {
      needed_action: checked.needed_action,
    });
  }

  const clean = maskSecrets(input);
  const id = newId();
  const meta = {
    ...(checked.meta ?? {}),
    inline_sha256: clean.payload ? (checked.sha256 ?? null) : null,
    inline_bytes: clean.payload ? Buffer.byteLength(clean.payload) : 0,
    redacted: clean.redacted,
  };
  await sql`
    INSERT INTO exec_evidence (id, organization_id, task_id, criterion_id, kind, ref, summary,
                               payload, sha256, size_bytes, meta, recorded_by)
    VALUES (${id}, ${actor.organizationId}, ${task.id}::uuid, ${criterion?.id ?? null}::uuid,
            ${input.kind}, ${clean.ref}, ${clean.summary}, ${clean.payload ?? null}, ${checked.sha256 ?? null},
            ${checked.size_bytes ?? null}, ${toJsonb(meta) as never}::jsonb, ${actor.actorId})
  `.execute(db as never);

  const verified = criterion ? carriesProof(clean.payload, checked.sha256 ?? null) : false;
  if (criterion && verified) {
    await sql`
      UPDATE exec_criteria SET status = 'verified', verified_at = now()
      WHERE id = ${criterion.id}::uuid AND status = 'pending'
    `.execute(db as never);
  }

  await appendEvent(db, {
    organization_id: actor.organizationId,
    task_id: task.id,
    entity: 'evidence',
    entity_id: id,
    entity_code: task.code,
    action: 'evidence.added',
    actor_type: actor.actorType,
    actor_id: actor.actorId,
    tool: actor.tool ?? null,
    payload: {
      before: null,
      after: {
        kind: input.kind,
        ref: clean.ref,
        criterion: criterion?.code ?? null,
        verified,
        redacted: clean.redacted,
        bytes: checked.size_bytes ?? 0,
      },
    },
  });

  return {
    id,
    task_code: task.code,
    criterion_code: criterion?.code ?? null,
    kind: input.kind,
    ref: clean.ref,
    summary: clean.summary,
    sha256: checked.sha256 ?? null,
    size_bytes: checked.size_bytes ?? null,
    verified,
    redacted: clean.redacted,
    meta,
  };
}

/**
 * Secrets never reach the ledger (acceptance B.16). The mask happens here, on
 * the way in — the one place every write of an evidence row goes through.
 */
export function maskSecrets(input: { ref: string; summary: string; payload?: string }): {
  ref: string;
  summary: string;
  payload?: string;
  redacted: number;
} {
  const ref = redactSecrets(input.ref);
  const summary = redactSecrets(input.summary);
  const payload = input.payload === undefined ? undefined : redactSecrets(input.payload);
  return {
    ref: ref.text,
    summary: summary.text,
    payload: payload?.text,
    redacted: ref.hits + summary.hits + (payload?.hits ?? 0),
  };
}

/** A criterion counts as proven when the evidence carries a payload or a hash. */
function carriesProof(payload: string | undefined, sha256: string | null): boolean {
  return (payload ?? '').trim().length > 0 || (sha256 ?? '').trim().length > 0;
}

/** `id::text = ref` — a criterion may be named by id or by code (never a mix). */
async function findCriterion(db: DbLike, taskId: string, ref: string): Promise<{ id: string; code: string } | null> {
  const r = await sql<{ id: string; code: string }>`
    SELECT id, code FROM exec_criteria
    WHERE task_id = ${taskId}::uuid AND (id::text = ${ref} OR code = ${ref})
  `.execute(db as never);
  return r.rows[0] ?? null;
}

/** The operator's knobs, read from the settings the plan defines. */
export async function loadEvidenceDeps(
  db: DbLike,
  orgId: string,
  projectId: string,
  fs: EvidenceFsLike,
): Promise<EvidenceDeps> {
  const [roots, maxBytes, parser] = await Promise.all([
    getEffective(db, 'exec.allowed_repo_roots', orgId, projectId),
    getEffective(db, 'exec.evidence_max_bytes', orgId, projectId),
    getEffective(db, 'exec.test_result_parser', orgId, projectId),
  ]);
  const rootList = Array.isArray(roots?.value) ? (roots.value as string[]) : [];
  const size = typeof maxBytes?.value === 'number' ? (maxBytes.value as number) : 131_072;
  const p = parser?.value as { pass: string[]; fail: string[]; skip: string[] } | undefined;
  return {
    fs,
    roots: rootList,
    maxBytes: size,
    parser: p ? { pass: p.pass ?? [], fail: p.fail ?? [], skip: p.skip ?? [] } : undefined,
  };
}

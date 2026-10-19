import { sql } from 'kysely';
import { AppError, factInputSchema, factQueryInputSchema, type FactInput, type FactQueryInput } from '@forgepm/shared';
import type { DbLike } from '../db/unitOfWork';
import { newId } from '../id';
import { toJsonb } from '../jsonb';
import { allocateLedgerCode } from './codes';
import { appendEvent } from './events';
import { inspectFactEvidence } from './fact-evidence';
import { flagFactDependentsForRevisit } from './fact-verification';
import type { ExecFactFileSource } from './review-source';
import type { LedgerActor } from './open-items-service';

export interface FactRecordResult {
  id: string;
  code: string;
  key: string;
  value: string;
  kind: FactInput['kind'];
  source: FactInput['source'];
  source_ref: string | null;
  files: string[];
  status: 'active';
  verified_at: string;
  superseded: string[];
}

interface PriorFact {
  id: string;
  code: string;
  key: string;
  status: 'active' | 'stale';
}

/** Record a fact without overwriting history; the caller owns the transaction. */
export async function recordFact(
  db: DbLike,
  actor: LedgerActor,
  raw: unknown,
  source: ExecFactFileSource | null,
): Promise<FactRecordResult> {
  const parsed = factInputSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path?.length ? `${issue.path.join('.')}: ` : '';
    throw new AppError('VALIDATION_ERROR', `${path}${issue?.message ?? 'invalid fact payload'}`, {
      needed_action: issue?.message ?? 'send key, value, kind, source and inspectable evidence',
    });
  }
  const input = parsed.data;
  const evidence = await inspectFactEvidence(
    db,
    actor,
    {
      source: input.source,
      sourceRef: input.source_ref,
      files: input.files,
      requireSourceRef: input.kind === 'fact' && (input.source === 'code' || input.source === 'tool_output'),
      requireCodeFiles: input.kind === 'fact' && input.source === 'code',
    },
    source,
  );

  const id = newId();
  const code = await allocateLedgerCode(db, actor.projectId, 'F', actor.organizationId);
  const prior = await sql<PriorFact>`
    SELECT id::text AS id, code, key, status
    FROM exec_facts
    WHERE organization_id = ${actor.organizationId}::uuid AND project_id = ${actor.projectId}::uuid
      AND key = ${input.key} AND status IN ('active','stale')
    ORDER BY created_at DESC, code
    FOR UPDATE
  `.execute(db as never);
  const verifiedAt = new Date();
  const initialStatus = prior.rows.length ? 'stale' : 'active';

  // Insert first in a non-active state when replacing a key: superseded_by is
  // an immediate FK, so the new id must exist before prior rows can point to it.
  await sql`
    INSERT INTO exec_facts
      (id, organization_id, project_id, code, key, value, kind, source, source_ref,
       files, file_hashes, verified_at, status)
    VALUES
      (${id}::uuid, ${actor.organizationId}::uuid, ${actor.projectId}::uuid, ${code}, ${input.key}, ${input.value},
       ${input.kind}, ${input.source}, ${input.source_ref?.trim() || null},
       ${toJsonb(evidence.files) as never}::jsonb, ${toJsonb(evidence.fileHashes) as never}::jsonb,
       ${verifiedAt}, ${initialStatus})
  `.execute(db as never);

  for (const old of prior.rows) {
    await flagFactDependentsForRevisit(db, actor, old, `superseded by ${code}`);
    await sql`
      UPDATE exec_facts SET status = 'superseded', superseded_by = ${id}::uuid
      WHERE id = ${old.id}::uuid AND status IN ('active','stale')
    `.execute(db as never);
    await appendEvent(db, {
      organization_id: actor.organizationId,
      task_id: null,
      entity: 'fact',
      entity_id: old.id,
      entity_code: old.code,
      action: 'fact.superseded',
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      tool: actor.tool ?? 'fact_record',
      payload: { before: { status: old.status, code: old.code }, after: { status: 'superseded', superseded_by: code } },
    });
  }
  if (initialStatus !== 'active') {
    await sql`UPDATE exec_facts SET status = 'active' WHERE id = ${id}::uuid`.execute(db as never);
  }

  await appendEvent(db, {
    organization_id: actor.organizationId,
    task_id: null,
    entity: 'fact',
    entity_id: id,
    entity_code: code,
    action: 'fact.recorded',
    actor_type: actor.actorType,
    actor_id: actor.actorId,
    tool: actor.tool ?? 'fact_record',
    payload: {
      before: null,
      after: {
        code,
        key: input.key,
        kind: input.kind,
        source: input.source,
        source_ref: input.source_ref?.trim() || null,
        files: evidence.files,
        file_hashes: evidence.fileHashes,
        status: 'active',
      },
    },
  });

  return {
    id,
    code,
    key: input.key,
    value: input.value,
    kind: input.kind,
    source: input.source,
    source_ref: input.source_ref?.trim() || null,
    files: evidence.files,
    status: 'active',
    verified_at: verifiedAt.toISOString(),
    superseded: prior.rows.map((row) => row.code),
  };
}

export interface FactQueryResult {
  project_id: string;
  query: string | null;
  count: number;
  limit: number;
  facts: Record<string, unknown>[];
  warnings: { code: string; warning: string }[];
}

/** Stale rows stay visible, explicitly labelled as untrusted current truth. */
export async function queryFacts(
  db: DbLike,
  actor: Pick<LedgerActor, 'organizationId' | 'projectId'>,
  raw: unknown = {},
): Promise<FactQueryResult> {
  const parsed = factQueryInputSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError('VALIDATION_ERROR', issue?.message ?? 'invalid fact query', {
      needed_action: 'send an optional query, limit (1–10), and include_superseded flag',
    });
  }
  const input: FactQueryInput = parsed.data;
  const query = input.query?.trim() || null;
  const rows = await sql<{
    id: string;
    code: string;
    key: string;
    value: string;
    kind: string;
    source: string;
    source_ref: string | null;
    files: unknown;
    status: string;
    verified_at: string | null;
    superseded_by: string | null;
  }>`
    SELECT id::text AS id, code, key, value, kind, source, source_ref, files, status,
      verified_at::text AS verified_at, superseded_by::text AS superseded_by
    FROM exec_facts
    WHERE organization_id = ${actor.organizationId}::uuid AND project_id = ${actor.projectId}::uuid
      AND (${input.include_superseded} OR status <> 'superseded')
      AND (${query === null ? sql`true` : sql`position(lower(${query}) in lower(key)) > 0 OR position(lower(${query}) in lower(value)) > 0`})
    ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'stale' THEN 1 WHEN 'rejected' THEN 2 ELSE 3 END,
      created_at DESC, code
    LIMIT ${input.limit}
  `.execute(db as never);

  const facts = rows.rows.map((row) => ({
    id: row.id,
    code: row.code,
    key: row.key,
    value: row.value,
    kind: row.kind,
    source: row.source,
    source_ref: row.source_ref,
    files: stringArray(row.files),
    status: row.status,
    verified_at: row.verified_at,
    superseded_by: row.superseded_by,
    ...(row.status === 'stale'
      ? { warning: 'STALE: source evidence changed or could not be verified; do not rely on this value as current truth.' }
      : {}),
  }));
  const warnings = facts
    .filter((fact) => fact.status === 'stale')
    .map((fact) => ({ code: String(fact.code), warning: String(fact.warning) }));
  return { project_id: actor.projectId, query, count: facts.length, limit: input.limit, facts, warnings };
}

function stringArray(value: unknown): string[] {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [];
}

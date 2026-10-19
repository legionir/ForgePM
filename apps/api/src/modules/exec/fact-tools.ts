import { z } from 'zod';
import {
  AppError,
  factInputBaseSchema,
  factInputRefinement,
  factPromotionInputSchema,
  factQueryInputSchema,
  factVerifyInputSchema,
} from '@forgepm/shared';
import {
  applyFactVerification,
  prepareFactVerification,
  promoteFact,
  queryFacts,
  recordFact,
  resolveExecReviewSource,
  unitOfWork,
  type Db,
} from '@forgepm/core';
import type { Actor } from '../../app/auth-context';
import { auditIn, ledgerActor, parseTool, projectRefSchema, resolveProject } from './context';

export const factRecordToolSchema = factInputBaseSchema
  .extend({ project_ref: projectRefSchema.optional() })
  .superRefine(factInputRefinement);

export const factQueryToolSchema = factQueryInputSchema.extend({ project_ref: projectRefSchema.optional() });
export const factVerifyToolSchema = factVerifyInputSchema.extend({ project_ref: projectRefSchema.optional() });
export const factPromoteToolSchema = factPromotionInputSchema.extend({
  fact_ref: z.string().min(1).max(64),
  project_ref: projectRefSchema.optional(),
});

export async function factRecordTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const tool = parseTool<Record<string, unknown>>(
    factRecordToolSchema,
    raw,
    'send { key, value, kind, source, source_ref?, files?, project_ref? }; source files are checked and hashed by ForgePM',
  );
  const projectId = await resolveProject(db, actor, tool.project_ref as string | undefined, 'project:write');
  const payload = { ...tool };
  delete payload.project_ref;
  const ledger = ledgerActor(actor, projectId, 'fact_record');
  let out: unknown;
  await unitOfWork(db, async ({ tx }) => {
    const row = await recordFact(tx, ledger, payload, resolveExecReviewSource());
    await auditIn(tx, actor, 'exec.fact.record', 'exec_fact', row.id, {
      code: row.code,
      key: row.key,
      kind: row.kind,
      source: row.source,
      source_ref: row.source_ref,
      files: row.files,
      superseded: row.superseded,
    });
    out = row;
  });
  return out;
}

export async function factQueryTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const tool = parseTool<Record<string, unknown>>(factQueryToolSchema, raw, 'send { query?, limit?, include_superseded?, project_ref? }');
  const projectId = await resolveProject(db, actor, tool.project_ref as string | undefined, 'project:read');
  const query = { ...tool };
  delete query.project_ref;
  return queryFacts(db, { organizationId: actor.organizationId, projectId }, query);
}

export async function factVerifyTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const tool = parseTool<Record<string, unknown>>(
    factVerifyToolSchema,
    raw,
    'send { fact_ref, project_ref? }; ForgePM re-reads every referenced file and compares its stored hash',
  );
  const projectId = await resolveProject(db, actor, tool.project_ref as string | undefined, 'project:write');
  const ledger = ledgerActor(actor, projectId, 'fact_verify');
  const source = resolveExecReviewSource();
  const prepared = await prepareFactVerification(db, ledger, source, String(tool.fact_ref));
  let out: unknown;
  await unitOfWork(db, async ({ tx }) => {
    const result = await applyFactVerification(tx, ledger, prepared);
    for (const change of result.changes) {
      await auditIn(tx, actor, change.to === 'stale' ? 'exec.fact.stale' : 'exec.fact.verify', 'exec_fact', change.id, {
        code: change.code,
        from: change.from,
        to: change.to,
        changed_files: change.changed_files,
        warning: change.warning,
      });
    }
    out = {
      fact_ref: tool.fact_ref,
      checked: result.checked,
      ...(result.changes[0] ?? { status: 'active', changed_files: [] }),
      ...(prepared.unavailable_reason ? { warning: prepared.unavailable_reason } : {}),
    };
  });
  return out;
}

export async function factPromoteTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const tool = parseTool<Record<string, unknown>>(
    factPromoteToolSchema,
    raw,
    'send { fact_ref, reason, source?, source_ref? }; only a human may confirm a guess as fact',
  );
  if (actor.type === 'agent') {
    throw new AppError('FORBIDDEN', 'only a human may promote an assumption into a project fact', {
      needed_action: 'ask the human; an agent must not turn its own guess into project truth',
    });
  }
  const projectId = await resolveProject(db, actor, tool.project_ref as string | undefined, 'project:write');
  const ledger = ledgerActor(actor, projectId, 'fact_promote');
  let out: unknown;
  await unitOfWork(db, async ({ tx }) => {
    const row = await promoteFact(
      tx,
      ledger,
      String(tool.fact_ref),
      { source: tool.source as string | undefined, source_ref: tool.source_ref as string | undefined, reason: String(tool.reason) },
      resolveExecReviewSource(),
    );
    const fact = await tx
      .selectFrom('exec_facts')
      .select('id')
      .where('project_id', '=', projectId)
      .where('code', '=', row.code)
      .executeTakeFirstOrThrow();
    await auditIn(tx, actor, 'exec.fact.promote', 'exec_fact', fact.id, { code: row.code, source: row.source });
    out = row;
  });
  return out;
}

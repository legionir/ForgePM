import {
  materializeRequirementConflicts,
  addRequirement,
  changeRequirement,
  linkRequirement,
  requirementCoverage,
  unitOfWork,
  type Db,
} from '@forgepm/core';
import {
  idOrCodeSchema,
  requirementInputBaseSchema,
  reqCoverageInputSchema,
  reqLinkTaskInputSchema,
} from '@forgepm/shared';
import type { Actor } from '../../app/auth-context';
import { auditIn, ledgerActor, parseTool, projectRefSchema, resolveProject } from './context';

// Keep semantic quote validation in the core service so failures retain the
// ledger's UNPROCESSABLE code instead of being flattened by MCP schema parsing.
export const reqAddToolSchema = requirementInputBaseSchema.extend({ project_ref: projectRefSchema.optional() });
export const reqChangeToolSchema = requirementInputBaseSchema.extend({
  requirement_ref: idOrCodeSchema,
  project_ref: projectRefSchema.optional(),
});
export const reqLinkTaskToolSchema = reqLinkTaskInputSchema.extend({ project_ref: projectRefSchema.optional() });
export const reqCoverageToolSchema = reqCoverageInputSchema.extend({ project_ref: projectRefSchema.optional() });

export async function reqAddTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const tool = parseTool<Record<string, unknown>>(
    reqAddToolSchema,
    raw,
    'send { text, quote, source, kind, priority } — quote must be verbatim and text must be checkable',
  );
  const projectId = await resolveProject(db, actor, tool.project_ref as string | undefined, 'project:write');
  const { project_ref: _projectRef, ...payload } = tool;
  void _projectRef;
  let out: unknown;
  await unitOfWork(db, async ({ tx }) => {
    const ledger = ledgerActor(actor, projectId, 'req_add');
    const row = await addRequirement(tx, ledger, payload);
    const conflicts = await materializeRequirementConflicts(tx, ledger);
    await auditIn(tx, actor, 'exec.requirement.add', 'exec_requirement', row.id, {
      code: row.code,
      source: row.source,
      conflicts: conflicts.map((conflict) => conflict.conflict),
    });
    out = { ...row, conflicts };
  });
  return out;
}

export async function reqLinkTaskTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const tool = parseTool<Record<string, unknown>>(
    reqLinkTaskToolSchema,
    raw,
    'send { requirement_ref, task_ref, criterion_refs[] } to link each criterion to exactly one requirement',
  );
  const projectId = await resolveProject(db, actor, tool.project_ref as string | undefined, 'project:write');
  let out: unknown;
  await unitOfWork(db, async ({ tx }) => {
    const ledger = ledgerActor(actor, projectId, 'req_link_task');
    const row = await linkRequirement(
      tx,
      ledger,
      String(tool.requirement_ref),
      String(tool.task_ref),
      tool.criterion_refs as string[],
    );
    const conflicts = await materializeRequirementConflicts(tx, ledger);
    await auditIn(tx, actor, 'exec.requirement.link_task', 'exec_requirement', row.requirement_id, {
      task: row.task,
      criteria: row.criteria,
      conflicts: conflicts.map((conflict) => conflict.conflict),
    });
    out = { ...row, conflicts };
  });
  return out;
}

export async function reqChangeTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const tool = parseTool<Record<string, unknown>>(
    reqChangeToolSchema,
    raw,
    'send { requirement_ref, text, quote, source, kind, priority } with a verbatim quote and checkable text',
  );
  const projectId = await resolveProject(db, actor, tool.project_ref as string | undefined, 'project:write');
  const { requirement_ref: requirementRef, project_ref: _projectRef, ...payload } = tool;
  void _projectRef;
  let out: unknown;
  await unitOfWork(db, async ({ tx }) => {
    const ledger = ledgerActor(actor, projectId, 'req_change');
    const row = await changeRequirement(tx, ledger, String(requirementRef), payload);
    const conflicts = await materializeRequirementConflicts(tx, ledger);
    await auditIn(tx, actor, 'exec.requirement.change', 'exec_requirement', row.id, {
      code: row.code,
      revisited_criteria: row.revisited_criteria,
      revisited_decisions: row.revisited_decisions,
      reopened_tasks: row.reopened_tasks,
      conflicts: conflicts.map((conflict) => conflict.conflict),
    });
    out = { ...row, conflicts };
  });
  return out;
}

export async function reqCoverageTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const tool = parseTool<Record<string, unknown>>(reqCoverageToolSchema, raw, 'send {} or { project_ref }');
  const projectId = await resolveProject(db, actor, tool.project_ref as string | undefined, 'project:read');
  return requirementCoverage(db, { organizationId: actor.organizationId, projectId });
}

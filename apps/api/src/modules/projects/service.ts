import { AppError, type CreateProjectInput, type UpdateProjectInput, type ProjectDto } from '@forgepm/shared';
import { unitOfWork, recordAudit, type Db, type Action } from '@forgepm/core';
import {
  findProjectById,
  insertProject,
  listProjects,
  softDeleteProject,
  updateProject,
  rowToProjectDto,
  type ProjectRow,
} from './repository';
import type { Actor } from '../../app/auth-context';
import { assertProjectAccess } from './access';

export interface ListOpts {
  includeArchived?: boolean;
}

/**
 * Create a project (service is the sole writer — plan §1.2). Domain change +
 * audit_event happen in one transaction (plan §3b-3).
 */
export async function createProject(
  db: Db,
  actor: Actor,
  input: CreateProjectInput,
  action: Action = 'project:create',
): Promise<ProjectDto> {
  void action; // authorization already ran in the guard; kept for context.
  const organizationId = actor.organizationId;
  const requestId = actor.requestId;
  let id = '';
  let row: ProjectRow | undefined;

  await unitOfWork(db, async ({ tx }) => {
    try {
      id = await insertProject(tx, {
        organization_id: organizationId,
        key: input.key,
        name: input.name,
        description: input.description ?? null,
        priority: input.priority,
        start_date: input.start_date ?? null,
        target_date: input.target_date ?? null,
      });
    } catch (err) {
      if (isUniqueViolation(err, 'projects_organization_id_key_key')) {
        throw new AppError('CONFLICT', `project key '${input.key}' already exists`);
      }
      throw err;
    }
    await recordAudit(tx, {
      organization_id: organizationId,
      actor_type: actor.type === 'agent' ? 'agent' : 'user',
      actor_id: actor.id,
      action: 'project.create',
      resource_type: 'project',
      resource_id: id,
      summary: { before: null, after: { key: input.key, name: input.name } },
      request_id: requestId,
    });
    row = await findProjectById(tx, id, organizationId);
  });
  if (!row) throw new AppError('INTERNAL', 'project vanished');
  return rowToProjectDto(row);
}

export async function patchProject(db: Db, actor: Actor, projectId: string, patch: UpdateProjectInput): Promise<ProjectDto> {
  await assertProjectAccess(db, actor, projectId, 'project:settings');
  const before = await findProjectById(db, projectId, actor.organizationId);
  if (!before) throw new AppError('NOT_FOUND', 'project not found');

  let row: ProjectRow | undefined;
  await unitOfWork(db, async ({ tx }) => {
    try {
      row = await updateProject(tx, projectId, actor.organizationId, patch);
    } catch (err) {
      if (isUniqueViolation(err, 'projects_organization_id_key_key')) {
        throw new AppError('CONFLICT', `project key '${patch.key}' already exists`);
      }
      throw err;
    }
    await recordAudit(tx, {
      organization_id: actor.organizationId,
      actor_type: actor.type === 'agent' ? 'agent' : 'user',
      actor_id: actor.id,
      action: 'project.update',
      resource_type: 'project',
      resource_id: projectId,
      summary: { before: beforeToSummary(before), after: rowToSummary(row) },
      request_id: actor.requestId,
    });
  });
  return rowToProjectDto(row!);
}

export async function archiveProject(db: Db, actor: Actor, projectId: string, archived: boolean): Promise<ProjectDto> {
  await assertProjectAccess(db, actor, projectId, 'project:archive');
  const before = await findProjectById(db, projectId, actor.organizationId);
  if (!before) throw new AppError('NOT_FOUND', 'project not found');
  let row: ProjectRow | undefined;
  await unitOfWork(db, async ({ tx }) => {
    row = await updateProject(tx, projectId, actor.organizationId, {
      status: archived ? 'archived' : 'active',
      archived_at: archived ? new Date() : null,
    });
    await recordAudit(tx, {
      organization_id: actor.organizationId,
      actor_type: actor.type === 'agent' ? 'agent' : 'user',
      actor_id: actor.id,
      action: archived ? 'project.archive' : 'project.unarchive',
      resource_type: 'project',
      resource_id: projectId,
      summary: { before: beforeToSummary(before), after: rowToSummary(row) },
      request_id: actor.requestId,
    });
  });
  return rowToProjectDto(row!);
}

export async function removeProject(db: Db, actor: Actor, projectId: string): Promise<void> {
  await assertProjectAccess(db, actor, projectId, 'project:archive');
  await unitOfWork(db, async ({ tx }) => {
    await softDeleteProject(tx, projectId, actor.organizationId);
    await recordAudit(tx, {
      organization_id: actor.organizationId,
      actor_type: actor.type === 'agent' ? 'agent' : 'user',
      actor_id: actor.id,
      action: 'project.soft_delete',
      resource_type: 'project',
      resource_id: projectId,
      summary: null,
      request_id: actor.requestId,
    });
  });
}

export async function getProject(db: Db, actor: Actor, projectId: string): Promise<ProjectDto> {
  await assertProjectAccess(db, actor, projectId, 'project:read');
  const r = await findProjectById(db, projectId, actor.organizationId);
  if (!r) throw new AppError('NOT_FOUND', 'project not found');
  return rowToProjectDto(r);
}

export async function listProjectsFor(db: Db, actor: Actor, query: Parameters<typeof listProjects>[2], opts: ListOpts = {}) {
  // owner/admin see all org projects; member/viewer users only their own;
  // agent API keys are restricted to their project_ids (guard enforced above).
  // API keys are always restricted to their project_ids set when present.
  let restrict: string[] | null = actor.projectIds ?? null;
  if (actor.type === 'user' && actor.projectIds === null && (actor.orgRole === 'member' || actor.orgRole === 'viewer')) {
    const rows = await db
      .selectFrom('project_members')
      .select('project_id')
      .where('user_id', '=', actor.id)
      .execute();
    restrict = rows.map((r) => r.project_id);
  }
  return listProjects(db, actor.organizationId, query, opts.includeArchived === true, { restrictToProjectIds: restrict });
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && (e.constraint === undefined || e.constraint === constraint);
}

function beforeToSummary(r: ProjectRow): Record<string, unknown> {
  const d = rowToProjectDto(r);
  return { key: d.key, name: d.name, description: d.description, status: d.status, priority: d.priority };
}

function rowToSummary(r?: ProjectRow): Record<string, unknown> | null {
  if (!r) return null;
  return beforeToSummary(r);
}


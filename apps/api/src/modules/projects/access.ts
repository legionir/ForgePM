import { AppError, type ProjectRole } from '@forgepm/shared';
import { can, type Action, type DbLike } from '@forgepm/core';
import type { Actor } from '../../app/auth-context';
import { findProjectById } from './repository';

/**
 * Project-scope access check with tenancy-correct status codes (plan §5
 * acceptance): a project that does not exist OR that the actor cannot see
 * (member/viewer not in the project) => 404 NOT_FOUND — never reveals
 * existence across projects/orgs. Visible-but-not-allowed => 403 FORBIDDEN.
 */
export async function projectRoleOf(db: DbLike, actor: Actor, projectId: string): Promise<ProjectRole | null> {
  const pm = await db
    .selectFrom('project_members')
    .select('role')
    .where('project_id', '=', projectId)
    .where('user_id', '=', actor.id)
    .executeTakeFirst();
  return (pm?.role as ProjectRole) ?? null;
}

export async function assertProjectAccess(db: DbLike, actor: Actor, projectId: string, action: Action): Promise<void> {
  // API keys restricted to a project set: other projects => 404 (no leak).
  if (actor.projectIds !== null && !actor.projectIds.includes(projectId)) {
    throw new AppError('NOT_FOUND', 'project not found');
  }
  const project = await findProjectById(db as never, projectId, actor.organizationId);
  if (!project) throw new AppError('NOT_FOUND', 'project not found');

  // Agent actors authorize via scopes (checked in guard) + project restriction.
  if (actor.type === 'agent') return;

  const role = await projectRoleOf(db, actor, projectId);
  // member/viewer org roles who are not project members: same 404 as missing.
  if (role === null && (actor.orgRole === 'member' || actor.orgRole === 'viewer' || actor.orgRole === null)) {
    throw new AppError('NOT_FOUND', 'project not found');
  }
  if (!can({ orgRole: actor.orgRole, projectRole: role }, action)) {
    throw new AppError('FORBIDDEN', `action '${action}' not allowed for this project`);
  }
}

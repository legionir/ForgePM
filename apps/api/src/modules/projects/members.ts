import { newId, unitOfWork, recordAudit, type DbLike } from '@forgepm/core';
import type { ProjectRole } from '@forgepm/shared';
import type { Actor } from '../../app/auth-context';
import { assertProjectAccess } from './access';

export interface ProjectMemberView {
  user_id: string;
  role: ProjectRole;
  email: string;
  display_name: string;
}

export async function listProjectMembers(db: DbLike, projectId: string, _orgId: string): Promise<ProjectMemberView[]> {
  const rows = await db
    .selectFrom('project_members')
    .innerJoin('users', 'users.id', 'project_members.user_id')
    .select(['project_members.user_id as user_id', 'project_members.role as role', 'users.email as email', 'users.display_name as display_name'])
    .where('project_members.project_id', '=', projectId)
    .execute();
  return rows.map((r) => ({ user_id: r.user_id, role: r.role as ProjectRole, email: r.email, display_name: r.display_name }));
}

export async function upsertProjectMember(
  db: DbLike,
  actor: Actor,
  projectId: string,
  userId: string,
  role: ProjectRole,
): Promise<void> {
  await assertProjectAccess(db, actor, projectId, 'project:members');
  await unitOfWork(db as never, async ({ tx }) => {
    const existing = await tx
      .selectFrom('project_members')
      .select('id')
      .where('project_id', '=', projectId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (existing) {
      await tx.updateTable('project_members').set({ role }).where('id', '=', existing.id).execute();
    } else {
      await tx
        .insertInto('project_members')
        .values({ id: newId(), project_id: projectId, user_id: userId, role })
        .execute();
    }
    await recordAudit(tx, {
      organization_id: actor.organizationId,
      actor_type: actor.type === 'agent' ? 'agent' : 'user',
      actor_id: actor.id,
      action: 'project.member_upsert',
      resource_type: 'project',
      resource_id: projectId,
      summary: { user_id: userId, role },
      request_id: actor.requestId,
    });
  });
}

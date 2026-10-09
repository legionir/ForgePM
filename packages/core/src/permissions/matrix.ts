import { AppError } from '@forgepm/shared';
import type { OrgRole, ProjectRole } from '@forgepm/shared';

/**
 * Permission matrix (plan §5.5). Pure function so it can be unit-tested at
 * 100% and reused by REST guards and (Phase 4) MCP tool checks.
 *
 * Actions are namespaced strings: `project:create`, `project:read`,
 * `project:settings`, `org:manage`, `users:manage`, `apikeys:self`,
 * `apikeys:manage`, `audit:read`, `settings:system`, `jobs:read`,
 * `project:archive`, `project:write`, `project:members`.
 *
 * `orgRole` is the actor's role in the organization; `projectRole` is their
 * role in the target project (null when not a member). owner/admin have
 * implicit access to every project in the org (plan §5 matrix note).
 */
export type Action =
  | 'org:manage'
  | 'users:manage'
  | 'settings:system'
  | 'project:create'
  | 'project:archive'
  | 'project:read'
  | 'project:write'
  | 'project:settings'
  | 'project:members'
  | 'apikeys:self'
  | 'apikeys:manage'
  | 'audit:read'
  | 'jobs:read'
  | 'secrets:manage'
  | 'plan:approve'
  | 'plan:apply';

export interface ActorAccess {
  orgRole: OrgRole | null;
  projectRole: ProjectRole | null;
}

const ORG_RANK: Record<OrgRole, number> = { owner: 3, admin: 2, member: 1, viewer: 0 };

function orgAtLeast(role: OrgRole | null, min: OrgRole): boolean {
  return role !== null && ORG_RANK[role] >= ORG_RANK[min];
}

export function can(actor: ActorAccess, action: Action): boolean {
  const { orgRole, projectRole } = actor;
  switch (action) {
    case 'org:manage':
      return orgRole === 'owner';
    case 'users:manage':
      return orgAtLeast(orgRole, 'admin');
    case 'settings:system':
      return orgRole === 'owner';
    case 'project:create':
    case 'project:archive':
      return orgAtLeast(orgRole, 'admin');
    // owner/admin have implicit access to every project in the org;
    // member/viewer only reach projects they are members of (tenancy).
    case 'project:read':
      return orgAtLeast(orgRole, 'admin') || projectRole !== null;
    case 'project:write':
      return orgAtLeast(orgRole, 'admin') || projectRole === 'lead' || projectRole === 'contributor';
    case 'project:settings':
      return orgAtLeast(orgRole, 'admin') || projectRole === 'lead';
    case 'project:members':
      return orgAtLeast(orgRole, 'admin') || projectRole === 'lead';
    case 'apikeys:self':
      return orgRole !== null; // any org member manages their own keys
    case 'apikeys:manage':
      return orgAtLeast(orgRole, 'admin');
    case 'audit:read':
      return orgAtLeast(orgRole, 'admin');
    case 'jobs:read':
      return orgAtLeast(orgRole, 'admin');
    case 'secrets:manage':
      return orgAtLeast(orgRole, 'admin');
    case 'plan:approve':
      return orgAtLeast(orgRole, 'admin') || projectRole === 'lead';
    case 'plan:apply':
      return orgAtLeast(orgRole, 'admin') || projectRole === 'lead';
  }
}

/** Throws FORBIDDEN when the action is not allowed (plan §3b-6 order). */
export function authorize(actor: ActorAccess, action: Action): void {
  if (!can(actor, action)) throw new AppError('FORBIDDEN', `action '${action}' not allowed`);
}

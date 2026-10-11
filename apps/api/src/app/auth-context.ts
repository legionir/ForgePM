import type { FastifyRequest } from 'fastify';
import { AppError, type OrgRole, type ProjectRole, type ApiKeyScope } from '@forgepm/shared';
import { hashApiKey, verifyApiKey, type Db } from '@forgepm/core';

/**
 * Authenticated actor for a request. Both a panel user (session cookie) and a
 * machine caller (API key) resolve to this shape so services stay transport
 * agnostic (plan §1.2). `scopes`/`projectIds` are only set for API keys.
 */
export interface Actor {
  type: 'user' | 'agent';
  id: string;
  organizationId: string;
  orgRole: OrgRole | null;
  /** project id -> role, for project-scoped permission checks. */
  projectRole(projectId: string): ProjectRole | null;
  scopes: ApiKeyScope[];
  /** null = not restricted to specific projects. */
  projectIds: string[] | null;
  apiKeyId?: string;
  requestId: string;
}

export interface SessionInfo {
  user_id: string;
  organization_id: string;
  org_role: OrgRole;
}

export const SESSION_COOKIE = 'fpm_session';
export const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
  }
}

/**
 * Verify a Bearer API key against `api_keys` and load its owner's org
 * membership context. Runtime auth (plan §3b-6 step 1) — revoked/expired keys
 * are rejected here even if they once appeared in tools/list.
 */
export async function resolveApiKeyActor(db: Db, raw: string, requestId: string): Promise<Actor> {
  const hash = hashApiKey(raw);
  const row = await db
    .selectFrom('api_keys')
    .select(['id', 'organization_id', 'owner_user_id', 'agent_id', 'key_hash', 'scopes', 'project_ids', 'expires_at', 'revoked_at'])
    .where('key_hash', '=', hash)
    .executeTakeFirst();
  if (!row) throw new AppError('AUTH_REQUIRED', 'invalid api key');
  if (row.revoked_at) throw new AppError('AUTH_REQUIRED', 'api key revoked');
  if (row.expires_at && row.expires_at.getTime() < Date.now()) throw new AppError('AUTH_REQUIRED', 'api key expired');
  if (!verifyApiKey(raw, row.key_hash)) throw new AppError('AUTH_REQUIRED', 'invalid api key');

  // POU-14: verify owner user is active and not deleted before authorizing key
  if (row.owner_user_id) {
    const user = await db
      .selectFrom('users')
      .select(['id', 'status'])
      .where('id', '=', row.owner_user_id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!user || user.status !== 'active') throw new AppError('AUTH_REQUIRED', 'api key owner disabled or deleted');
  }

  const projectIds = (row.project_ids as string[]) ?? [];
  const member = row.owner_user_id
    ? await db
        .selectFrom('memberships')
        .select(['role'])
        .where('user_id', '=', row.owner_user_id)
        .where('organization_id', '=', row.organization_id)
        .executeTakeFirst()
    : null;

  // Owner users keep their project roles; agent-owned keys are restricted to
  // their project_ids + scopes only (fine-grained agent roles arrive with MCP).
  const roleByProject = new Map<string, ProjectRole>();
  if (row.owner_user_id) {
    const pms = await db
      .selectFrom('project_members')
      .innerJoin('projects', 'projects.id', 'project_members.project_id')
      .select(['project_members.project_id as project_id', 'project_members.role as role'])
      .where('project_members.user_id', '=', row.owner_user_id)
      .where('projects.organization_id', '=', row.organization_id)
      .execute();
    for (const p of pms) roleByProject.set(p.project_id, p.role as ProjectRole);
  }

  return {
    type: row.agent_id ? 'agent' : 'user',
    id: (row.agent_id ?? row.owner_user_id) as string,
    organizationId: row.organization_id,
    orgRole: (member?.role as OrgRole) ?? (row.agent_id ? 'member' : null),
    projectRole: (projectId: string) => roleByProject.get(projectId) ?? null,
    scopes: row.scopes as ApiKeyScope[],
    projectIds: projectIds.length > 0 ? projectIds : null,
    apiKeyId: row.id,
    requestId,
  };
}

/** Resolve a panel session (httpOnly cookie) into an Actor. */
export async function resolveSessionActor(db: Db, token: string, requestId: string): Promise<Actor> {
  const hash = generateSessionTokenHash(token);
  const row = await db
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .select([
      'sessions.user_id as user_id',
      'sessions.expires_at as expires_at',
      'users.status as status',
    ])
    .where('sessions.token_hash', '=', hash)
    .executeTakeFirst();
  if (!row) throw new AppError('AUTH_REQUIRED', 'invalid session');
  if (row.expires_at.getTime() < Date.now()) throw new AppError('AUTH_REQUIRED', 'session expired');
  if (row.status !== 'active') throw new AppError('AUTH_REQUIRED', 'user disabled');

  const memberships = await db
    .selectFrom('memberships')
    .select(['organization_id', 'role'])
    .where('user_id', '=', row.user_id)
    .execute();
  if (memberships.length === 0) throw new AppError('AUTH_REQUIRED', 'no organization');
  const m = memberships[0]; // Phase 1: single-org users (multi-org deferred)

  const projectMembers = await db
    .selectFrom('project_members')
    .innerJoin('projects', 'projects.id', 'project_members.project_id')
    .select(['project_members.project_id as project_id', 'project_members.role as role'])
    .where('project_members.user_id', '=', row.user_id)
    .where('projects.organization_id', '=', m.organization_id)
    .execute();
  const roleByProject = new Map<string, ProjectRole>(
    projectMembers.map((p) => [p.project_id, p.role as ProjectRole]),
  );

  return {
    type: 'user',
    id: row.user_id,
    organizationId: m.organization_id,
    orgRole: m.role as OrgRole,
    projectRole: (projectId: string) => roleByProject.get(projectId) ?? null,
    scopes: ['read', 'write', 'plan', 'plan_approve', 'plan_apply', 'review', 'github', 'admin'],
    projectIds: null,
    requestId,
  };
}

export function generateSessionTokenHash(token: string): string {
  return hashApiKey(token); // same SHA-256 hex scheme
}

/** preHandler: require an authenticated actor (session cookie or Bearer key). */
export function requireAuth(db: Db) {
  return async function preHandler(req: FastifyRequest): Promise<void> {
    const actor = await authenticate(db, req);
    req.actor = actor;
  };
}

export async function authenticate(db: Db, req: FastifyRequest): Promise<Actor> {
  const authz = req.headers.authorization;
  if (authz && authz.startsWith('Bearer ')) {
    return resolveApiKeyActor(db, authz.slice(7).trim(), req.id);
  }
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    try {
      return await resolveSessionActor(db, token, req.id);
    } catch (err) {
      // A Bearer-less session failure is only fatal if there was no key.
      if (!(err instanceof AppError) || err.code !== 'AUTH_REQUIRED') throw err;
      throw new AppError('AUTH_REQUIRED', 'authentication required');
    }
  }
  throw new AppError('AUTH_REQUIRED', 'authentication required');
}

/** Get the actor stashed by the authenticate preHandler. */
export function actorOf(req: FastifyRequest): Actor {
  const actor = (req as FastifyRequest & { actor?: Actor }).actor;
  if (!actor) throw new AppError('AUTH_REQUIRED', 'authentication required');
  return actor;
}

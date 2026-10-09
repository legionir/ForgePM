import type { FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import { authenticate, actorOf, type Actor } from '../app/auth-context';
import { AppError, type ApiKeyScope } from '@forgepm/shared';
import { authorize, type Action, type Db } from '@forgepm/core';
import { csrfGuard } from '../modules/auth/routes';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface GuardOpts {
  /** org-level action (checked before project-level by the service). */
  action?: Action;
  /** API-key scope required when the caller used a Bearer token. */
  scope?: ApiKeyScope;
  /** require authentication; true by default. */
  auth?: boolean;
}

/**
 * Route preHandler enforcing plan §3b-6 order for Phase 1:
 *   1) auth (session/API key validity)  5) scope check for keys
 *   CSRF for mutating requests (5.3).
 * Project-level authorization (steps 3-4) runs in the service via
 * `assertProjectAccess` so we can return the correct 404-vs-403 shape.
 */
export function guard(db: Db, opts: GuardOpts = {}): RouteOptions['preHandler'] {
  const authRequired = opts.auth !== false;
  return async function preHandler(req: FastifyRequest, _reply: FastifyReply) {
    if (!authRequired) return;
    const actor = await authenticate(db, req);
    req.actor = actor;

    if (opts.scope && req.headers.authorization && !actor.scopes.includes(opts.scope)) {
      throw new AppError('FORBIDDEN_SCOPE', `api key missing scope '${opts.scope}'`);
    }
    if (opts.action) {
      authorize({ orgRole: actor.orgRole, projectRole: actor.projectRole('') }, opts.action);
    }
    if (MUTATING.has(req.method)) await csrfGuard(req);
  };
}

export function requireActor(req: FastifyRequest): Actor {
  return actorOf(req);
}

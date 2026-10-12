import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { AppDeps } from '../../app/app';
import { actorOf, requireAuth } from '../../app/auth-context';
import { authorize, newId, recordAudit, unitOfWork } from '@forgepm/core';

/**
 * Module lifecycle admin routes (plan §3b-1, §4.4).
 * These let the panel enable/disable a module at runtime without restart.
 * Phase 0 gates with requireAuth + org:manage (owner only); audit records actor + request_id.
 */
const toggleParams = z.object({ name: z.string().min(1).max(64) });
const toggleBody = z.object({ enabled: z.boolean() });
const statusResponse = z.object({
  modules: z.array(z.object({ name: z.string(), enabled: z.boolean(), registered: z.boolean() })),
});

export function registerModulesRoutes(app: FastifyInstance, deps: AppDeps): void {
  const t = app.withTypeProvider<ZodTypeProvider>();

  const list = async () => {
    const defs = deps.registry.list();
    const modules = await Promise.all(
      defs.map(async (d) => ({
        name: d.name,
        enabled: await deps.registry.isEnabled(deps.db, d.name, null, null),
        registered: true,
      })),
    );
    return { modules };
  };

  // List every registered module and its effective enabled flag.
  t.get('/api/v1/modules', { schema: { response: { 200: statusResponse } } }, list);

  // Enable/disable a module; require owner org role (org:manage) so unauthenticated
  // requests get 401 and non-owner members get 403 (POU-10 acceptance).
  t.put(
    '/api/v1/modules/:name/enabled',
    {
      schema: { params: toggleParams, body: toggleBody, response: { 200: statusResponse } },
      preHandler: requireAuth(deps.db),
    },
    async (req) => {
      const actor = actorOf(req);
      authorize({ orgRole: actor.orgRole, projectRole: null }, 'org:manage');
      const { name } = req.params;
      const { enabled } = req.body;
      if (enabled) await deps.registry.enable(deps.db, name, null);
      else await deps.registry.disable(deps.db, name, null);
      await unitOfWork(deps.db, async ({ tx }) => {
        await recordAudit(tx, {
          organization_id: actor.organizationId,
          actor_type: actor.type === 'agent' ? 'agent' : 'user',
          actor_id: actor.id,
          action: enabled ? 'module.enable' : 'module.disable',
          resource_type: 'module',
          resource_id: newId(),
          summary: { module: name, enabled },
          request_id: actor.requestId,
        });
      });
      return list();
    },
  );
}

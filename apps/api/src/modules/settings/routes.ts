import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { AppDeps } from '../../app/app';

/**
 * Module lifecycle admin routes (plan §3b-1, §4.4).
 * These let the panel enable/disable a module at runtime without restart.
 * Real role-based authorization lands in Phase 1 (permissions module);
 * Phase 0 exposes the mechanism for tests + wiring.
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

  // Enable/disable a module; enable runs validateConfig first (plan §3b-1.4).
  t.put(
    '/api/v1/modules/:name/enabled',
    { schema: { params: toggleParams, body: toggleBody, response: { 200: statusResponse } } },
    async (req) => {
      const { name } = req.params;
      const { enabled } = req.body;
      if (enabled) await deps.registry.enable(deps.db, name, null);
      else await deps.registry.disable(deps.db, name, null);
      return list();
    },
  );
}

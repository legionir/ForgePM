import { z } from 'zod';
import { type FastifyInstance, type RouteOptions } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

/**
 * Sample module — exists to exercise the module lifecycle (plan §3b-1, §4.6).
 * Routes are ALWAYS registered; the requireModule guard decides at request
 * time whether the module is enabled. Disabled => 503 MODULE_DISABLED.
 */
const echoBody = z.object({ message: z.string().max(200) });
const echoResponse = z.object({ echo: z.string() });

// system-scope sample module: its flag lives at the `system` settings level.
const SAMPLE_CTX = { organizationId: null, projectId: null };

export function registerSampleModule(app: FastifyInstance): void {
  const t = app.withTypeProvider<ZodTypeProvider>();

  const guard: RouteOptions['preHandler'] = async (req) => {
    await req.server.requireModule('sample', SAMPLE_CTX);
  };

  t.post(
    '/sample/echo',
    { schema: { body: echoBody, response: { 200: echoResponse } }, preHandler: guard },
    async (req) => ({ echo: req.body.message }),
  );

  // Read-only guarded endpoint — proves routes exist while the module is off.
  t.get(
    '/sample/status',
    { schema: { response: { 200: z.object({ module: z.string(), state: z.string() }) } }, preHandler: guard },
    async () => ({ module: 'sample', state: 'active' }),
  );
}

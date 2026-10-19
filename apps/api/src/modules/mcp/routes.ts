import type { FastifyInstance } from 'fastify';
import { makeMcpHandler, type McpDeps } from './dispatch';

/**
 * Register the Streamable-HTTP MCP endpoint. The handler parses JSON-RPC
 * bodies directly (raw content-type) so the Fastify zod validator doesn't
 * need to know about every RPC shape.
 */
export function registerMcpRoutes(app: FastifyInstance, deps: McpDeps): void {
  const handler = makeMcpHandler(deps);
  // R-09: snapshot/MCP payloads may carry file manifests; allow 32 MiB per
  // request, 413 when total exceeds it (global stays 1 MiB for other routes).
  app.post('/mcp', { config: { bodyLimit: 32 * 1024 * 1024 } } as never, async (req, reply) => {
    // Fastify already enforces bodyLimit, but Zod-mcp payloads (files[]) need
    // an explicit total check so a 20k×1 MiB advisory_only does not pass.
    const body = req.body as { params?: { arguments?: { files?: unknown[]; payload?: string } } } | null;
    const args = body?.params?.arguments as { files?: unknown[]; payload?: string } | undefined;
    if (args) {
      let total = 0;
      if (typeof args.payload === 'string') total += Buffer.byteLength(args.payload, 'utf8');
      if (Array.isArray(args.files)) {
        for (const f of args.files) {
          if (typeof f === 'string') total += Buffer.byteLength(f, 'utf8');
          else if (f && typeof f === 'object' && 'patch' in (f as Record<string, unknown>)) {
            const p = (f as { patch?: string }).patch;
            if (typeof p === 'string') total += Buffer.byteLength(p, 'utf8');
          }
        }
      }
      if (total > 32 * 1024 * 1024) {
        return void reply.status(413).send({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'snapshot payload exceeds 32 MiB total', request_id: req.id } });
      }
    }
    await handler(req, reply);
  });
}

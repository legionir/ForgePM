import type { FastifyInstance } from 'fastify';
import { makeMcpHandler, type McpDeps } from './dispatch';

/**
 * Register the Streamable-HTTP MCP endpoint. The handler parses JSON-RPC
 * bodies directly (raw content-type) so the Fastify zod validator doesn't
 * need to know about every RPC shape.
 */
export function registerMcpRoutes(app: FastifyInstance, deps: McpDeps): void {
  const handler = makeMcpHandler(deps);
  // Content-type parser for JSON is already the default; /mcp is POST-only.
  app.post('/mcp', async (req, reply) => {
    await handler(req, reply);
  });
}

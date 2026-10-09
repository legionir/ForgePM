import type { FastifyInstance } from 'fastify';

export interface CollectedRoute {
  method: string;
  url: string;
  schema?: Record<string, unknown>;
}

/**
 * Install an `onRoute` hook that records every route as it is registered.
 * Returns a getter snapshotting the collected routes. (Fastify v5 removed the
 * public `app.routes` table, so we build the OpenAPI doc from this hook.)
 */
export function collectRoutes(app: FastifyInstance): () => CollectedRoute[] {
  const collected: CollectedRoute[] = [];
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const m of methods) {
      collected.push({ method: String(m), url: route.url, schema: route.schema as Record<string, unknown> | undefined });
    }
  });
  return () => [...collected];
}

/**
 * Minimal OpenAPI 3.0 document from the collected Fastify routes.
 * fastify-type-provider-zod attaches JSON schemas to route configs; the full
 * generated-client pipeline (`pnpm gen:api`) is wired in Phase 1/7.
 */
export function buildOpenApiDocument(routes: CollectedRoute[]) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    if (r.method === 'HEAD' || r.method === 'OPTIONS') continue;
    const method = String(r.method).toLowerCase();
    const path = r.url.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\*/g, '{wildcard}');
    paths[path] ??= {};
    const schema = (r.schema ?? {}) as Record<string, unknown>;
    paths[path][method] = {
      summary: `${r.method} ${r.url}`,
      responses: { '200': { description: 'OK' }, ...(schema.response as object | undefined ?? {}) },
    };
  }
  return { openapi: '3.0.3', info: { title: 'ForgePM API', version: '0.0.0' }, paths };
}

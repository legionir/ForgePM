import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { listQuerySchema, encodeCursor, decodeCursor } from '@forgepm/shared';
import type { AppDeps } from '../../app/app';
import { guard, requireActor } from '../../app/guards';

/**
 * GET /api/v1/mcp/calls — the §8.11 panel requirement "صفحه‌ی لاگ
 * mcp_tool_calls با فیلتر". Read-only, org-scoped, cursor-paginated.
 * `input_summary` is what dispatch.ts stored after masking (§8.8), so raw
 * token/key values never reach the panel either.
 */
const callDto = z.object({
  id: z.string(),
  api_key_id: z.string().nullable(),
  tool: z.string(),
  outcome: z.enum(['ok', 'error', 'pending_approval']),
  error_code: z.string().nullable(),
  duration_ms: z.number().nullable(),
  request_id: z.string().nullable(),
  created_at: z.string(),
});

export function registerMcpCallsRoutes(app: FastifyInstance, deps: AppDeps): void {
  const t = app.withTypeProvider<ZodTypeProvider>();
  const db = deps.db;

  t.get(
    '/api/v1/mcp/calls',
    {
      schema: {
        querystring: listQuerySchema.extend({
          tool: z.string().optional(),
          outcome: z.enum(['ok', 'error', 'pending_approval']).optional(),
        }),
        response: { 200: z.object({ items: z.array(callDto), next_cursor: z.string().nullable() }) },
      },
      preHandler: guard(db, { action: 'audit:read' }),
    },
    async (req) => {
      const actor = requireActor(req);
      let q = db
        .selectFrom('mcp_tool_calls')
        .selectAll()
        .where('organization_id', '=', actor.organizationId);
      if (req.query.tool) q = q.where('tool', '=', req.query.tool);
      if (req.query.outcome) q = q.where('outcome', '=', req.query.outcome);
      if (req.query.cursor) {
        const { createdAt, id } = decodeCursor(req.query.cursor);
        q = q.where((eb) =>
          eb.or([eb('created_at', '<', new Date(createdAt)), eb.and([eb('created_at', '=', new Date(createdAt)), eb('id', '<', id)])]),
        );
      }
      const rows = await q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(req.query.limit + 1).execute();
      const hasMore = rows.length > req.query.limit;
      const slice = hasMore ? rows.slice(0, req.query.limit) : rows;
      return {
        items: slice.map((r) => ({
          id: r.id,
          api_key_id: r.api_key_id,
          tool: r.tool,
          outcome: r.outcome,
          error_code: r.error_code,
          duration_ms: r.duration_ms,
          request_id: r.request_id,
          created_at: r.created_at.toISOString(),
        })),
        next_cursor: hasMore ? encodeCursor(slice[slice.length - 1].created_at.toISOString(), slice[slice.length - 1].id) : null,
      };
    },
  );
}

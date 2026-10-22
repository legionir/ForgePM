import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { listQuerySchema, decodeCursor, encodeCursor } from '@forgepm/shared';
import type { AppDeps } from '../../app/app';
import { guard, requireActor } from '../../app/guards';
import { cursorTs, rowCursorTs, tsParam } from '../../app/keyset';

const auditDto = z.object({
  id: z.string(),
  actor_type: z.string(),
  actor_id: z.string(),
  action: z.string(),
  resource_type: z.string(),
  resource_id: z.string(),
  summary: z.unknown().nullable(),
  request_id: z.string().nullable(),
  created_at: z.string(),
});

export function registerAuditRoutes(app: FastifyInstance, deps: AppDeps): void {
  const t = app.withTypeProvider<ZodTypeProvider>();
  const db = deps.db;

  t.get(
    '/api/v1/audit',
    {
      schema: {
        querystring: listQuerySchema.extend({ resource_type: z.string().optional(), resource_id: z.string().optional() }),
        response: {
          200: z.object({ items: z.array(auditDto), next_cursor: z.string().nullable() }),
        },
      },
      preHandler: guard(db, { action: 'audit:read' }),
    },
    async (req) => {
      const actor = requireActor(req);
      let q = db
        .selectFrom('audit_events')
        .select(['id', 'actor_type', 'actor_id', 'action', 'resource_type', 'resource_id', 'summary', 'request_id', 'created_at', cursorTs()])
        .where('organization_id', '=', actor.organizationId);
      if (req.query.resource_type) q = q.where('resource_type', '=', req.query.resource_type);
      if (req.query.resource_id) q = q.where('resource_id', '=', req.query.resource_id);
      if (req.query.cursor) {
        const { createdAt, id } = decodeCursor(req.query.cursor);
        q = q.where((eb) =>
          eb.or([eb('created_at', '<', tsParam(createdAt)), eb.and([eb('created_at', '=', tsParam(createdAt)), eb('id', '<', id)])]),
        );
      }
      const rows = await q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(req.query.limit + 1).execute();
      const hasMore = rows.length > req.query.limit;
      const slice = hasMore ? rows.slice(0, req.query.limit) : rows;
      return {
        items: slice.map((r) => ({
          id: r.id,
          actor_type: r.actor_type,
          actor_id: r.actor_id,
          action: r.action,
          resource_type: r.resource_type,
          resource_id: r.resource_id,
          summary: r.summary ?? null,
          request_id: r.request_id ?? null,
          created_at: (r.created_at as Date).toISOString(),
        })),
        next_cursor: hasMore ? encodeCursor(rowCursorTs(slice[slice.length - 1]), slice[slice.length - 1].id) : null,
      };
    },
  );
}

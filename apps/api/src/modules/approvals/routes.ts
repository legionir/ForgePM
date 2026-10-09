import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { guard, requireActor } from '../../app/guards';
import type { AppDeps } from '../../app/app';
import { decide, listPending, type ApprovalRow } from './service';

const dto = z.object({
  id: z.string(),
  project_id: z.string().nullable(),
  requested_by: z.string(),
  action: z.string(),
  risk: z.string(),
  status: z.string(),
  decided_by: z.string().nullable(),
  reason: z.string().nullable(),
  created_at: z.string(),
});

function toDto(r: ApprovalRow) {
  return {
    id: r.id,
    project_id: r.project_id,
    requested_by: r.requested_by,
    action: r.action,
    risk: r.risk,
    status: r.status,
    decided_by: r.decided_by,
    reason: r.reason,
    created_at: r.created_at.toISOString(),
  };
}

export function registerApprovalsRoutes(app: FastifyInstance, deps: AppDeps): void {
  const t = app.withTypeProvider<ZodTypeProvider>();
  const db = deps.db;

  t.get(
    '/api/v1/approvals',
    { schema: { response: { 200: z.object({ items: z.array(dto) }) } }, preHandler: guard(db, { scope: 'read' }) },
    async (req) => ({ items: (await listPending(db, requireActor(req).organizationId)).map(toDto) }),
  );

  t.post(
    '/api/v1/approvals/:id/decide',
    { schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ decision: z.enum(['approved', 'rejected']), reason: z.string().max(1000).optional() }), response: { 200: dto } }, preHandler: guard(db, { scope: 'admin' }) },
    async (req) => {
      const actor = requireActor(req);
      const row = await decide(db, actor, req.params.id, req.body.decision, req.body.reason);
      return toDto(row);
    },
  );
}

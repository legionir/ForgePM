import { z } from 'zod';
import {
  loadFinding,
  updateFindingStatus,
  createWorkItemFromFinding,
  requestFindingApproval,
  hasApprovedFindingRequest,
  effectiveIssuePolicy,
  type Db,
  type McpCallContext,
  type McpToolDefinition,
} from '@forgepm/core';
import { assertProjectAccess } from '../projects/access';
import type { Actor } from '../../app/auth-context';
import { startCodeReview, startRefactorReview, runReport } from './runners';
import { codeReviewInputSchema, refactorReviewInputSchema } from './service';

/** MCP ctx.actor is the same runtime shape the services expect (as in tools.ts). */
const actorOf = (ctx: McpCallContext): Actor => ctx.actor as unknown as Actor;

/**
 * Review MCP tools (plan §10). Handlers call the SAME services as REST; the
 * dispatcher enforces scope `review` + module enablement at call time, and the
 * `tools/list` filter hides a disabled module's tools entirely.
 */
export function buildReviewTools(db: Db): McpToolDefinition[] {
  const tool = (t: McpToolDefinition): McpToolDefinition => t;

  return [
    tool({
      name: 'review_start_code_review',
      description: 'Start a Code Review run for a PR (hunks + commit snapshot supplied by the caller).',
      inputSchema: codeReviewInputSchema,
      scopes: ['review'],
      annotations: { destructiveHint: false, idempotentHint: true },
      module: 'code_review',
      handler: async (args, ctx) => startCodeReview(db, actorOf(ctx), codeReviewInputSchema.parse(args)),
    }),
    tool({
      name: 'review_get_report',
      description: 'Get a review run report (status, stats, config snapshot).',
      inputSchema: z.object({ run_id: z.string().uuid() }),
      scopes: ['review'],
      module: ['code_review', 'refactor_review'],
      annotations: { readOnlyHint: true },
      handler: async (args, ctx) => {
        const a = actorOf(ctx);
        const run = await db.selectFrom('review_runs').select(['id', 'organization_id', 'project_id']).where('id', '=', args.run_id as string).executeTakeFirst();
        if (!run || run.organization_id !== a.organizationId) throw new Error('NOT_FOUND');
        await assertProjectAccess(db, a, run.project_id, 'project:read');
        return runReport(db, a.organizationId, args.run_id as string);
      },
    }),
    tool({
      name: 'review_list_findings',
      description: 'List findings for a project with optional filters (cursor-paginated).',
      inputSchema: z.object({
        project_id: z.string().uuid(),
        severity: z.enum(['info', 'low', 'medium', 'high', 'critical']).optional(),
        status: z.enum(['open', 'dismissed', 'accepted', 'issue_created', 'not_seen', 'fixed']).optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      scopes: ['review'],
      module: ['code_review', 'refactor_review'],
      annotations: { readOnlyHint: true },
      handler: async (args, ctx) => {
        const a = actorOf(ctx);
        await assertProjectAccess(db, a, args.project_id as string, 'project:read');
        let q = db
          .selectFrom('review_findings')
          .select(['id', 'scope_key', 'category', 'severity', 'confidence', 'file', 'line_start', 'line_end', 'title', 'status', 'work_item_id', 'updated_at'])
          .where('organization_id', '=', a.organizationId)
          .where('project_id', '=', args.project_id as string)
          .orderBy('updated_at', 'desc')
          .limit(args.limit as number);
        if (args.severity) q = q.where('severity', '=', args.severity as never);
        if (args.status) q = q.where('status', '=', args.status as never);
        const rows = await q.execute();
        return { items: rows.map((r) => ({ ...r, confidence: Number(r.confidence) })) };
      },
    }),
    tool({
      name: 'review_update_finding',
      description: 'Dismiss / accept / reopen a finding (reason recorded).',
      inputSchema: z.object({ finding_id: z.string().uuid(), status: z.enum(['dismissed', 'accepted', 'open']), reason: z.string().max(2000).optional() }),
      scopes: ['review'],
      module: ['code_review', 'refactor_review'],
      annotations: { destructiveHint: false },
      handler: async (args, ctx) => {
        const a = actorOf(ctx);
        const f = await loadFinding(db, a.organizationId, args.finding_id as string);
        await assertProjectAccess(db, a, f.project_id, 'review:decide');
        await updateFindingStatus(db, {
          organizationId: a.organizationId,
          findingId: f.id,
          status: args.status as 'dismissed' | 'accepted' | 'open',
          reason: args.reason as string | undefined,
          actorType: a.type,
          actorId: a.id,
          requestId: a.requestId,
        });
        return { status: args.status };
      },
    }),
    tool({
      name: 'review_create_work_item_from_finding',
      description: 'Create a WorkItem from a finding (honours review.issue_policy; idempotent per finding).',
      inputSchema: z.object({ finding_id: z.string().uuid() }),
      scopes: ['review'],
      module: ['code_review', 'refactor_review'],
      annotations: { destructiveHint: false, idempotentHint: true },
      handler: async (args, ctx) => {
        const a = actorOf(ctx);
        const f = await loadFinding(db, a.organizationId, args.finding_id as string);
        await assertProjectAccess(db, a, f.project_id, 'review:decide');
        const policy = await effectiveIssuePolicy(db, a.organizationId, f.project_id);
        if (policy === 'human_approval') {
          const approved = await hasApprovedFindingRequest(db, a.organizationId, f.id);
          if (!approved) {
            const id = await requestFindingApproval(db, a.organizationId, f.project_id, f.id, a.id);
            return { approval_id: id, status: 'pending_approval' };
          }
        }
        return createWorkItemFromFinding(db, {
          organizationId: a.organizationId,
          findingId: f.id,
          actorType: a.type,
          actorId: a.id,
          requestId: a.requestId,
        });
      },
    }),
    tool({
      name: 'refactor_review_start',
      description: 'Start a Refactor Review run over a repository snapshot (files supplied by the caller; partitioned + incremental automatically).',
      inputSchema: refactorReviewInputSchema,
      scopes: ['review'],
      annotations: { destructiveHint: false, idempotentHint: true },
      module: 'refactor_review',
      handler: async (args, ctx) => startRefactorReview(db, actorOf(ctx), refactorReviewInputSchema.parse(args)),
    }),
    tool({
      name: 'refactor_review_get_report',
      description: 'Get a Refactor Review run report (partition cursor included).',
      inputSchema: z.object({ run_id: z.string().uuid() }),
      scopes: ['review'],
      annotations: { readOnlyHint: true },
      module: 'refactor_review',
      handler: async (args, ctx) => {
        const a = actorOf(ctx);
        const run = await db.selectFrom('review_runs').select(['id', 'organization_id', 'project_id', 'kind']).where('id', '=', args.run_id as string).executeTakeFirst();
        if (!run || run.organization_id !== a.organizationId || run.kind !== 'refactor') throw new Error('NOT_FOUND');
        await assertProjectAccess(db, a, run.project_id, 'project:read');
        return runReport(db, a.organizationId, args.run_id as string);
      },
    }),
    tool({
      name: 'refactor_review_list_findings',
      description: 'List Refactor Review findings for a project (impact/effort/risk present).',
      inputSchema: z.object({ project_id: z.string().uuid(), limit: z.number().int().min(1).max(200).default(50) }),
      scopes: ['review'],
      annotations: { readOnlyHint: true },
      module: 'refactor_review',
      handler: async (args, ctx) => {
        const a = actorOf(ctx);
        await assertProjectAccess(db, a, args.project_id as string, 'project:read');
        const runIds = db.selectFrom('review_runs').select('id').where('kind', '=', 'refactor').where('project_id', '=', args.project_id as string);
        const rows = await db
          .selectFrom('review_findings')
          .select(['id', 'category', 'severity', 'confidence', 'file', 'line_start', 'line_end', 'title', 'impact', 'effort', 'risk', 'status', 'work_item_id'])
          .where('organization_id', '=', a.organizationId)
          .where('project_id', '=', args.project_id as string)
          .where('run_id', 'in', runIds)
          .orderBy('updated_at', 'desc')
          .limit(args.limit as number)
          .execute();
        return { items: rows.map((r) => ({ ...r, confidence: Number(r.confidence) })) };
      },
    }),
  ];
}

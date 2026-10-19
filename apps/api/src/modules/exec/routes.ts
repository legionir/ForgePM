import { z } from 'zod';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AppError, factPromotionInputSchema, taskCancelInputSchema } from '@forgepm/shared';
import {
  answerQuestion,
  cancelSubtask,
  dropRequirement,
  waiveBaseline,
  waiveScopeMeasurement,
  listExecApprovals,
  dryRunGate,
  expandTaskScope,
  makeRequireModule,
  promoteFact,
  resolveOpenItem,
  resolveOpenItemByCode,
  resolveExecReviewSource,
  unitOfWork,
  waiveCriterion,
  type Db,
  type ModuleRegistry,
} from '@forgepm/core';
import { guard, requireActor } from '../../app/guards';
import { decide as decideApproval } from '../approvals/service';
import { auditIn, ledgerActor, projectForTask, resolveProject } from './context';
import { ledgerStatus } from './service';

/**
 * The HUMAN side of the execution ledger (plan §9.5).
 *
 * The agent can ask, file, prove and propose; only a human can answer,
 * approve, waive or close. These routes are that human's path — and they are
 * the routes the CLI (`scripts/ledger-cli.ts`) and the panel call, so there is
 * exactly one place where "a human decided" is recorded.
 *
 * Every mutating route needs the `ledger:decide` scope (D-040: human-only —
 * an agent's key must not carry it), and every route is behind the module
 * gate: with the module off the answer is 503 MODULE_DISABLED.
 */

/** The project a decision belongs to — its code is unique per project. */
async function projectForDecision(db: Db, actor: { organizationId: string }, code: string): Promise<string> {
  const found = await sql<{ project_id: string }>`
    SELECT t.project_id::text AS project_id
    FROM exec_decisions d JOIN exec_tasks t ON t.id = d.task_id
    WHERE d.organization_id = ${actor.organizationId}::uuid AND (d.code = ${code} OR d.id::text = ${code})
    LIMIT 1
  `.execute(db as never);
  const projectId = found.rows[0]?.project_id;
  if (!projectId) {
    throw new AppError('NOT_FOUND', `no decision '${code}' in this organisation`, { ref: code });
  }
  return projectId;
}

/** The project an open item belongs to — its code is unique per project. */
async function projectForItem(db: Db, actor: { organizationId: string }, code: string): Promise<string> {
  const found = await sql<{ project_id: string }>`
    SELECT t.project_id::text AS project_id
    FROM exec_open_items i JOIN exec_tasks t ON t.id = i.task_id
    WHERE i.organization_id = ${actor.organizationId}::uuid AND (i.code = ${code} OR i.id::text = ${code})
    LIMIT 1
  `.execute(db as never);
  const projectId = found.rows[0]?.project_id;
  if (!projectId) {
    throw new AppError('NOT_FOUND', `no open item '${code}' in this organisation`, { ref: code });
  }
  return projectId;
}

/** The project a criterion belongs to — through its task. */
async function projectForCriterion(db: Db, actor: { organizationId: string }, code: string): Promise<string> {
  const found = await sql<{ project_id: string }>`
    SELECT t.project_id::text AS project_id
    FROM exec_criteria c JOIN exec_tasks t ON t.id = c.task_id
    WHERE t.organization_id = ${actor.organizationId}::uuid AND (c.code = ${code} OR c.id::text = ${code})
    LIMIT 1
  `.execute(db as never);
  const projectId = found.rows[0]?.project_id;
  if (!projectId) {
    throw new AppError('NOT_FOUND', `no criterion '${code}' in this organisation`, { ref: code });
  }
  return projectId;
}

/** The project a fact belongs to — its code is unique per project. */
async function projectForFact(
  db: Db,
  actor: { organizationId: string; projectIds?: string[] | null },
  code: string,
): Promise<string> {
  const found = await sql<{ project_id: string }>`
    SELECT project_id::text AS project_id FROM exec_facts
    WHERE organization_id = ${actor.organizationId}::uuid AND (code = ${code} OR id::text = ${code})
      ${actor.projectIds ? sql`AND project_id = ANY(${actor.projectIds}::uuid[])` : sql``}
    LIMIT 1
  `.execute(db as never);
  const projectId = found.rows[0]?.project_id;
  if (!projectId) {
    throw new AppError('NOT_FOUND', `no fact '${code}' in this organisation`, { ref: code });
  }
  return projectId;
}

/**
 * A requirement may belong to the organisation rather than to a project, so
 * its project is what it has — and the actor's own project when it has none.
 */
async function projectForRequirement(
  db: Db,
  actor: { organizationId: string; projectIds?: string[] | null },
  code: string,
): Promise<string> {
  const found = await sql<{ project_id: string | null }>`
    SELECT project_id::text AS project_id FROM exec_requirements
    WHERE organization_id = ${actor.organizationId}::uuid AND (code = ${code} OR id::text = ${code})
    LIMIT 1
  `.execute(db as never);
  const row = found.rows[0];
  if (!row) {
    throw new AppError('NOT_FOUND', `no requirement '${code}' in this organisation`, { ref: code });
  }
  if (row.project_id) return row.project_id;
  if (actor.projectIds && actor.projectIds.length === 1) return actor.projectIds[0];
  throw new AppError('VALIDATION_ERROR', `requirement '${code}' belongs to no project`, {
    needed_action: 'the requirement is organisation-wide; pass project_ref to record the decision',
  });
}

/** The task itself — id and code — for the routes that work on a task. */
async function taskByRef(
  db: Db,
  actor: { organizationId: string; projectIds?: string[] | null },
  ref: string,
): Promise<{ id: string; code: string; project_id: string }> {
  const rows = await sql<{ id: string; code: string; project_id: string }>`
    SELECT id::text AS id, code, project_id::text AS project_id FROM exec_tasks
    WHERE organization_id = ${actor.organizationId}::uuid AND (code = ${ref} OR id::text = ${ref})
  `.execute(db as never);
  const found = rows.rows;
  const narrowed = actor.projectIds ? found.filter((r) => actor.projectIds?.includes(r.project_id)) : found;
  if (narrowed.length === 1) return narrowed[0];
  if (!narrowed.length) {
    throw new AppError('NOT_FOUND', `no ledger task '${ref}' you may act on`, { ref });
  }
  throw new AppError('VALIDATION_ERROR', `'${ref}' names a task in ${narrowed.length} projects`, {
    needed_action: 'pass project_ref to pick one',
  });
}

/** The project a question belongs to — its code is unique per project. */
async function projectForQuestion(db: Db, actor: { organizationId: string }, code: string): Promise<string> {
  const found = await sql<{ project_id: string }>`
    SELECT t.project_id::text AS project_id
    FROM exec_questions q JOIN exec_tasks t ON t.id = q.task_id
    WHERE q.organization_id = ${actor.organizationId}::uuid AND (q.code = ${code} OR q.id::text = ${code})
    LIMIT 1
  `.execute(db as never);
  const projectId = found.rows[0]?.project_id;
  if (!projectId) {
    throw new AppError('NOT_FOUND', `no question '${code}' in this organisation`, { ref: code });
  }
  return projectId;
}

export function registerExecRoutes(app: FastifyInstance, deps: { db: Db; registry: ModuleRegistry }): void {
  const db = deps.db;
  const requireModule = makeRequireModule(deps.registry, db);
  const t = app.withTypeProvider<ZodTypeProvider>();

  const gate = async (organizationId: string, projectId: string | null) => {
    await requireModule('exec', { organizationId, projectId });
  };

  /**
   * R-02 decision table — human verbs vs agent-allowed (plan §9.5, D-059).
   * Every mutating ledger route is human-only: the agent may ask/file/prove,
   * only a human may answer/approve/waive/close. The agent's own API key
   * (type=agent) and any key that lacks `ledger:decide` must get 403; a
   * browser session without X-CSRF-Token must get 403-CSRF (csrfGuard).
   *
   * | route                              | agent-allowed | scope         | agent key (ledger:decide) | user key (write) | session no CSRF | session+CSRF |
   * |------------------------------------|---------------|----------------|-------------------------------|----------------------|-----------------|--------------|
   * | POST /exec/items/:code/resolve     | no            | ledger:decide  | 403 FORBIDDEN                 | 403 FORBIDDEN_SCOPE  | 403 CSRF        | 200          |
   * | POST /exec/questions/:code/answer  | no            | ledger:decide  | 403                           | 403                  | 403 CSRF        | 200          |
   * | POST /exec/decisions/:code/decide  | no            | ledger:decide  | 403                           | 403                  | 403 CSRF        | 200          |
   * | POST /exec/approvals/:id/decide    | no            | ledger:decide  | 403                           | 403                  | 403 CSRF        | 200          |
   * | POST /exec/criteria/:code/waive    | no            | ledger:decide  | 403                           | 403                  | 403 CSRF        | 200          |
   * | POST /exec/requirements/:code/drop | no            | ledger:decide  | 403                           | 403                  | 403 CSRF        | 200          |
   * | POST /exec/scope/:taskId/expand    | no            | ledger:decide  | 403                           | 403                  | 403 CSRF        | 200          |
   * | POST /exec/tasks/:id/scope/waive   | no            | ledger:decide  | 403                           | 403                  | 403 CSRF        | 200          |
   * | POST /exec/tasks/:id/baseline/waive| no            | ledger:decide  | 403                           | 403                  | 403 CSRF        | 200          |
   * | POST /exec/facts/:code/promote     | no            | ledger:decide  | 403                           | 403                  | 403 CSRF        | 200          |
   * | GET  /exec/status, /plan, /approvals, POST /gate | yes | ledger:read | 200 | 200 | 200 | 200 |
   */
  const humanOnly = (actor: { type: string; apiKeyId?: string; scopes: string[] }) => {
    if (actor.type === 'agent') {
      throw new AppError('FORBIDDEN', 'this is the human path', {
        needed_action:
          'an agent may not answer, approve or close on a human behalf — the ledger records who decided, and that is you',
      });
    }
    // R-02: a user API key that lacks ledger:decide (e.g. generic write) must also 403
    if (actor.apiKeyId && !actor.scopes.includes('ledger:decide')) {
      throw new AppError('FORBIDDEN', 'this is the human path — your API key lacks ledger:decide', {
        needed_action: 'use a human session (panel/CLI with ledger:decide) or ask an owner for the scope',
      });
    }
  };

  // ---- the panel's projection (the same one the tool returns) ----
  t.get(
    '/api/v1/exec/status',
    {
      schema: {
        querystring: z.object({ project_ref: z.string().max(64).optional(), task_ref: z.string().max(64).optional() }),
      },
      preHandler: guard(db, { scope: 'ledger:read' }),
    },
    async (req) => {
      const actor = requireActor(req);
      const projectId = await resolveProject(db, actor, req.query.project_ref, 'project:read');
      await gate(actor.organizationId, projectId);
      return ledgerStatus(db, actor, { project_ref: projectId, task_ref: req.query.task_ref });
    },
  );

  // ---- plan view for the panel (same projection as the tool) ----
  t.get(
    '/api/v1/exec/plan',
    {
      schema: {
        querystring: z.object({
          project_ref: z.string().max(64).optional(),
          task_ref: z.string().max(64).optional(),
          cursor: z.string().max(64).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      },
      preHandler: guard(db, { scope: 'ledger:read' }),
    },
    async (req) => {
      const actor = requireActor(req);
      const projectId = await resolveProject(db, actor, req.query.project_ref, 'project:read');
      await gate(actor.organizationId, projectId);
      const { execPlanView } = await import('@forgepm/core');
      const view = await execPlanView(db as never, { organizationId: actor.organizationId, projectId, actorType: actor.type, actorId: actor.id } as never, req.query.task_ref);
      // simple cursor pagination on root codes
      const limit = req.query.limit ?? 50;
      let roots = view.roots;
      if (req.query.cursor) {
        const idx = roots.findIndex((r) => r.code === req.query.cursor);
        if (idx >= 0) roots = roots.slice(idx + 1);
      }
      const sliced = roots.slice(0, limit);
      const next_cursor = sliced.length === limit && roots.length > limit ? sliced[sliced.length - 1]!.code : null;
      return { project_id: view.project_id, roots: sliced, task_count: view.task_count, requirements: view.requirements, next_cursor };
    },
  );

  // ---- the exec rows of the approvals queue, in the ledger's own names ----
  t.get(
    '/api/v1/exec/approvals',
    {
      schema: {
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }),
      },
      preHandler: guard(db, { scope: 'ledger:read' }),
    },
    async (req) => {
      const actor = requireActor(req);
      // The queue is the organisation's, but the module may be on for a
      // project only — so the gate is asked with the actor's project when
      // there is one (the effective value falls back to the organisation).
      const projectId = actor.projectIds && actor.projectIds.length === 1 ? actor.projectIds[0] : null;
      await gate(actor.organizationId, projectId);
      return { items: await listExecApprovals(db, actor.organizationId, req.query.limit ?? 50) };
    },
  );

  // ---- a human resolves an open item (the soft closure of a blocker) ----
  t.post(
    '/api/v1/exec/items/:code/resolve',
    {
      schema: {
        params: z.object({ code: z.string().min(1).max(64) }),
        body: z.object({
          // Optional: the item codes are unique per project, so the CLI may
          // name the item alone.
          task_ref: z.string().min(1).max(64).optional(),
          status: z.enum(['resolved', 'accepted', 'deferred', 'wont_fix', 'not_applicable', 'open']),
          note: z.string().min(20).max(4000),
        }),
      },
      preHandler: guard(db, { scope: 'ledger:decide' }),
    },
    async (req) => {
      const actor = requireActor(req);
      humanOnly(actor);
      const projectId = req.body.task_ref
        ? await projectForTask(db, actor, req.body.task_ref)
        : await projectForItem(db, actor, req.params.code);
      await gate(actor.organizationId, projectId);
      let out: unknown;
      await unitOfWork(db, async ({ tx }) => {
        const payload = {
          item_ref: req.params.code,
          status: req.body.status,
          note: req.body.note,
        };
        const row = req.body.task_ref
          ? await resolveOpenItem(tx, ledgerActor(actor, projectId, 'exec.items.resolve'), req.body.task_ref, payload)
          : await resolveOpenItemByCode(
              tx,
              ledgerActor(actor, projectId, 'exec.items.resolve'),
              req.params.code,
              payload,
            );
        await auditIn(tx, actor, 'exec.open_item.resolve', 'exec_open_item', row.id, {
          code: row.code,
          status: row.status,
          by: row.resolved_by,
        });
        out = row;
      });
      return out;
    },
  );

  // ---- a human answers a question (and the task stops waiting) ----
  t.post(
    '/api/v1/exec/questions/:code/answer',
    {
      schema: {
        params: z.object({ code: z.string().min(1).max(64) }),
        body: z.object({ answer: z.string().min(1).max(4000) }),
      },
      preHandler: guard(db, { scope: 'ledger:decide' }),
    },
    async (req) => {
      const actor = requireActor(req);
      humanOnly(actor);
      // A question code is unique per project, so the project comes from the
      // question itself — a human with three projects must not have to guess.
      const projectId = await projectForQuestion(db, actor, req.params.code);
      await gate(actor.organizationId, projectId);
      let out: unknown;
      await unitOfWork(db, async ({ tx }) => {
        const row = await answerQuestion(
          tx,
          ledgerActor(actor, projectId, 'exec.questions.answer'),
          req.params.code,
          req.body.answer,
        );
        await auditIn(tx, actor, 'exec.question.answer', 'exec_question', row.id, {
          code: row.code,
          task: row.task_code,
        });
        out = row;
      });
      return out;
    },
  );

  // ---- a human decides a decision, by its code ----
  t.post(
    '/api/v1/exec/decisions/:code/decide',
    {
      schema: {
        params: z.object({ code: z.string().min(1).max(64) }),
        body: z.object({
          decision: z.enum(['approved', 'rejected']),
          reason: z.string().min(1).max(1000).optional(),
        }),
      },
      preHandler: guard(db, { scope: 'ledger:decide' }),
    },
    async (req) => {
      const actor = requireActor(req);
      humanOnly(actor);
      const projectId = await projectForDecision(db, actor, req.params.code);
      await gate(actor.organizationId, projectId);
      const found = await sql<{ approval_id: string | null; code: string }>`
        SELECT approval_id::text AS approval_id, code FROM exec_decisions
        WHERE organization_id = ${actor.organizationId}::uuid AND (code = ${req.params.code} OR id::text = ${req.params.code})
        LIMIT 1
      `.execute(db as never);
      const decision = found.rows[0];
      if (!decision) throw new AppError('NOT_FOUND', `no decision '${req.params.code}' in this organisation`);
      if (!decision.approval_id) {
        throw new AppError('LEDGER_STATE_INVALID', `decision ${decision.code} needs no approval`, {
          needed_action: 'this decision was below the approval level; it is already effective',
        });
      }
      const row = await decideApproval(db, actor, decision.approval_id, req.body.decision, req.body.reason);
      return { id: row.id, action: row.action, status: row.status, decided_by: row.decided_by, reason: row.reason };
    },
  );

  // ---- a human decides an approval (a decision that needs one) ----
  t.post(
    '/api/v1/exec/approvals/:id/decide',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          decision: z.enum(['approved', 'rejected']),
          reason: z.string().min(1).max(1000).optional(),
        }),
      },
      preHandler: guard(db, { scope: 'ledger:decide' }),
    },
    async (req) => {
      const actor = requireActor(req);
      humanOnly(actor);
      const row = await decideApproval(db, actor, req.params.id, req.body.decision, req.body.reason);
      return { id: row.id, action: row.action, status: row.status, decided_by: row.decided_by, reason: row.reason };
    },
  );

  // ---- a human waives an acceptance criterion ----
  t.post(
    '/api/v1/exec/criteria/:code/waive',
    {
      schema: {
        params: z.object({ code: z.string().min(1).max(64) }),
        body: z.object({ reason: z.string().min(10).max(2000) }),
      },
      preHandler: guard(db, { scope: 'ledger:decide' }),
    },
    async (req) => {
      const actor = requireActor(req);
      humanOnly(actor);
      const projectId = await projectForCriterion(db, actor, req.params.code);
      await gate(actor.organizationId, projectId);
      let out: unknown;
      await unitOfWork(db, async ({ tx }) => {
        const row = await waiveCriterion(
          tx,
          ledgerActor(actor, projectId, 'exec.criteria.waive'),
          req.params.code,
          req.body.reason,
        );
        await auditIn(tx, actor, 'exec.criterion.waive', 'exec_criterion', row.id, {
          code: row.code,
          task: row.task_code,
          approval_id: row.approval_id,
        });
        out = row;
      });
      return out;
    },
  );

  // ---- a human cancels a child task, with an approval record and parent-gate waiver ----
  t.post(
    '/api/v1/exec/tasks/:parentRef/children/:childRef/cancel',
    {
      schema: {
        params: z.object({ parentRef: z.string().min(1).max(64), childRef: z.string().min(1).max(64) }),
        body: taskCancelInputSchema.extend({ project_ref: z.string().min(1).max(64).optional() }),
      },
      preHandler: guard(db, { scope: 'ledger:decide' }),
    },
    async (req) => {
      const actor = requireActor(req);
      humanOnly(actor);
      const projectId = await projectForTask(db, actor, req.params.parentRef, req.body.project_ref);
      await gate(actor.organizationId, projectId);
      let out: unknown;
      await unitOfWork(db, async ({ tx }) => {
        const row = await cancelSubtask(
          tx,
          ledgerActor(actor, projectId, 'exec.subtask.cancel'),
          req.params.parentRef,
          req.params.childRef,
          req.body.reason,
        );
        await auditIn(tx, actor, 'exec.subtask.cancel', 'exec_task', row.task_id, {
          parent: row.parent,
          linked_requirements: row.linked_requirements,
          approval_id: row.approval_id,
          reason: row.reason,
        });
        out = row;
      });
      return out;
    },
  );

  // ---- a human drops a requirement ----
  t.post(
    '/api/v1/exec/requirements/:code/drop',
    {
      schema: {
        params: z.object({ code: z.string().min(1).max(64) }),
        body: z.object({ reason: z.string().min(10).max(2000) }),
      },
      preHandler: guard(db, { scope: 'ledger:decide' }),
    },
    async (req) => {
      const actor = requireActor(req);
      humanOnly(actor);
      const projectId = await projectForRequirement(db, actor, req.params.code);
      await gate(actor.organizationId, projectId);
      let out: unknown;
      await unitOfWork(db, async ({ tx }) => {
        const row = await dropRequirement(
          tx,
          ledgerActor(actor, projectId, 'exec.requirements.drop'),
          req.params.code,
          req.body.reason,
        );
        await auditIn(tx, actor, 'exec.requirement.drop', 'exec_requirement', row.id, {
          code: row.code,
          waived_criteria: row.waived_criteria,
          approval_id: row.approval_id,
        });
        out = row;
      });
      return out;
    },
  );

  // ---- a human widens a task's scope ----
  t.post(
    '/api/v1/exec/scope/:taskId/expand',
    {
      schema: {
        params: z.object({ taskId: z.string().min(1).max(64) }),
        body: z.object({
          paths: z.array(z.string().min(1).max(200)).min(1).max(200),
          reason: z.string().min(10).max(2000),
        }),
      },
      preHandler: guard(db, { scope: 'ledger:decide' }),
    },
    async (req) => {
      const actor = requireActor(req);
      humanOnly(actor);
      const task = await taskByRef(db, actor, req.params.taskId);
      await gate(actor.organizationId, task.project_id);
      let out: unknown;
      await unitOfWork(db, async ({ tx }) => {
        const row = await expandTaskScope(
          tx,
          ledgerActor(actor, task.project_id, 'exec.scope.expand'),
          task.id,
          req.body.paths,
          req.body.reason,
        );
        await auditIn(tx, actor, 'exec.scope.expand', 'exec_task', task.id, {
          task: task.code,
          added_paths: row.added_paths,
        });
        out = row;
      });
      return out;
    },
  );

  // ---- an explicit human waive when no scope source can be measured ----
  t.post(
    '/api/v1/exec/tasks/:taskId/scope/waive',
    {
      schema: {
        params: z.object({ taskId: z.string().min(1).max(64) }),
        body: z.object({ reason: z.string().min(10).max(2000) }),
      },
      preHandler: guard(db, { scope: 'ledger:decide' }),
    },
    async (req) => {
      const actor = requireActor(req);
      humanOnly(actor);
      const task = await taskByRef(db, actor, req.params.taskId);
      await gate(actor.organizationId, task.project_id);
      let out: unknown;
      await unitOfWork(db, async ({ tx }) => {
        const row = await waiveScopeMeasurement(
          tx,
          ledgerActor(actor, task.project_id, 'exec.scope.waive'),
          task.id,
          req.body.reason,
        );
        await auditIn(tx, actor, 'exec.scope.waive', 'exec_task', task.id, {
          task: task.code,
          approval_id: row.approval_id,
          reason: row.reason,
        });
        out = row;
      });
      return out;
    },
  );

  // ---- an explicit human waive for an unavailable CI baseline ----
  t.post(
    '/api/v1/exec/tasks/:taskId/baseline/waive',
    {
      schema: {
        params: z.object({ taskId: z.string().min(1).max(64) }),
        body: z.object({ reason: z.string().min(10).max(2000) }),
      },
      preHandler: guard(db, { scope: 'ledger:decide' }),
    },
    async (req) => {
      const actor = requireActor(req);
      humanOnly(actor);
      const task = await taskByRef(db, actor, req.params.taskId);
      await gate(actor.organizationId, task.project_id);
      let out: unknown;
      await unitOfWork(db, async ({ tx }) => {
        const row = await waiveBaseline(
          tx,
          ledgerActor(actor, task.project_id, 'exec.baseline.waive'),
          task.id,
          req.body.reason,
        );
        await auditIn(tx, actor, 'exec.baseline.waive', 'exec_task', task.id, {
          task: task.code,
          approval_id: row.approval_id,
          reason: row.reason,
        });
        out = row;
      });
      return out;
    },
  );

  // ---- a human promotes a guess into a fact ----
  t.post(
    '/api/v1/exec/facts/:code/promote',
    {
      schema: {
        params: z.object({ code: z.string().min(1).max(64) }),
        body: factPromotionInputSchema,
      },
      preHandler: guard(db, { scope: 'ledger:decide' }),
    },
    async (req) => {
      const actor = requireActor(req);
      humanOnly(actor);
      const projectId = await projectForFact(db, actor, req.params.code);
      await gate(actor.organizationId, projectId);
      let out: unknown;
      await unitOfWork(db, async ({ tx }) => {
        const row = await promoteFact(
          tx,
          ledgerActor(actor, projectId, 'exec.facts.promote'),
          req.params.code,
          {
            source: req.body.source,
            source_ref: req.body.source_ref,
            reason: req.body.reason,
          },
          resolveExecReviewSource(),
        );
        const fact = await tx
          .selectFrom('exec_facts')
          .select('id')
          .where('project_id', '=', projectId)
          .where('code', '=', row.code)
          .executeTakeFirstOrThrow();
        await auditIn(tx, actor, 'exec.fact.promote', 'exec_fact', fact.id, {
          code: row.code,
          source: row.source,
        });
        out = row;
      });
      return out;
    },
  );

  // ---- the gate, asked without closing anything ----
  t.post(
    '/api/v1/exec/gate/:taskId',
    {
      schema: {
        params: z.object({ taskId: z.string().min(1).max(64) }),
        body: z.object({}).strict().optional(),
      },
      preHandler: guard(db, { scope: 'ledger:read' }),
    },
    async (req) => {
      const actor = requireActor(req);
      const task = await taskByRef(db, actor, req.params.taskId);
      await gate(actor.organizationId, task.project_id);
      // A dry run writes nothing: no stamp, no report status, no event.
      const verdict = await dryRunGate(db, task.id);
      return {
        task_code: task.code,
        dry_run: true,
        ok: verdict.ok,
        blocked_by: verdict.blocked_by,
        gate_version: verdict.gate_version,
        tree_hash: verdict.tree_hash,
        status: verdict.status,
        report_id: verdict.report_id,
      };
    },
  );
}

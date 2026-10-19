import { taskStartInputSchema } from '@forgepm/shared';
import { type Db, type McpCallContext, type ToolRegistry } from '@forgepm/core';
import type { Actor } from '../../app/auth-context';
import {
  addOpenItem,
  ledgerStatus,
  listOpen,
  listToolSchema,
  openItemToolSchema,
  resolveItem,
  resolveToolSchema,
  startTask,
  statusToolSchema,
} from './service';

/**
 * PE-2's five mandatory ledger tools (plan §7). They are deliberately *thin*: the
 * schemas are the ones the service validates against, and every rule (blocking
 * defaults, dedup, soft-closure refusal, the one-event-per-mutation invariant) lives
 * in `@forgepm/core/src/exec`. A tool that re-implements a rule is a rule with two
 * answers, so there is exactly one place where each is decided.
 *
 * All five are gated on `module: 'exec'`: while the module is off, `tools/list` does
 * not contain them at all — the feature is invisible, not merely refused.
 */

type Tool = Parameters<ToolRegistry['register']>[0];

const actorOf = (ctx: McpCallContext): Actor => ctx.actor as unknown as Actor;

export function buildExecTools(db: Db): Tool[] {
  return [
    {
      name: 'exec_task_start',
      description:
        'Start a ledger task: creates the work item, the exec_tasks row and one exec_criteria row per acceptance criterion in ONE transaction, plus the audit row and the ledger event. Criteria are refused unless they are checkable (an observable outcome plus a reference such as test:NAME, file:path, commit:sha or cmd:…). allowed_paths is required because the scope of a task must be knowable from its start, not from its diff.',
      inputSchema: taskStartInputSchema,
      scopes: ['write'],
      annotations: { destructiveHint: false, idempotentHint: true },
      module: 'exec',
      handler: (args, ctx) => startTask(db, actorOf(ctx), args) as Promise<unknown>,
    },
    {
      name: 'ledger_add_open_item',
      description:
        'File an open item (question, commitment, incomplete requirement, bug…) against a task. `commitment` and `incomplete_requirement` are blocking by default; un-blocking one needs `why_not_blocking` of at least 40 characters. A near-duplicate of an item already on the task is answered with CONFLICT and the existing code — file it once, then update that row.',
      inputSchema: openItemToolSchema,
      scopes: ['write'],
      annotations: { destructiveHint: false },
      module: 'exec',
      handler: (args, ctx) => addOpenItem(db, actorOf(ctx), args) as Promise<unknown>,
    },
    {
      name: 'ledger_resolve_item',
      description:
        'Move an open item to another status. A soft closure (`deferred`, `accepted`, `wont_fix`, `not_applicable`) of a **blocking** item is refused for an agent with LEDGER_TRANSITION_NOT_ALLOWED — only a human may downgrade a blocker, and every closure needs a note of at least 20 characters. `resolved` is always available, and `open` reopens.',
      inputSchema: resolveToolSchema,
      scopes: ['write'],
      annotations: { destructiveHint: false },
      module: 'exec',
      handler: (args, ctx) => resolveItem(db, actorOf(ctx), args) as Promise<unknown>,
    },
    {
      name: 'ledger_list_open',
      description:
        'List a task’s open items, active ones first, then the closed ones as history. `active_only` (default true) restricts the list to what is still open. Nothing here deletes: a resolved item stays visible as evidence of what was decided.',
      inputSchema: listToolSchema,
      scopes: ['read'],
      annotations: { readOnlyHint: true },
      module: 'exec',
      handler: (args, ctx) => listOpen(db, actorOf(ctx), args) as Promise<unknown>,
    },
    {
      name: 'exec_ledger_status',
      description:
        'What stands between this task and a submission: blocking open items, criteria without evidence, unanswered blocking questions, decisions awaiting approval, and requirements no task covers. Answers with the same projection the panel renders, so tool and UI cannot disagree. With no task in the project it returns { empty: true } and says which tool to call.',
      inputSchema: statusToolSchema,
      scopes: ['read'],
      annotations: { readOnlyHint: true },
      module: 'exec',
      handler: (args, ctx) => ledgerStatus(db, actorOf(ctx), args) as Promise<unknown>,
    },
  ];
}

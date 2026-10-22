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
import { completeTaskTool, completeToolSchema, exitReportToolSchema, submitExitReportTool } from './closing-tools';
import { addEvidenceTool, evidenceToolSchema } from './evidence-tools';
import {
  factPromoteTool,
  factPromoteToolSchema,
  factQueryTool,
  factQueryToolSchema,
  factRecordTool,
  factRecordToolSchema,
  factVerifyTool,
  factVerifyToolSchema,
} from './fact-tools';
import { askHumanTool, decisionToolSchema, questionToolSchema, recordDecisionTool } from './decision-tools';
import { policyCheckTool, policyCheckToolSchema } from './policy-tools';
import { reviewTask, reviewTaskInputSchema } from './review-service';
import { scopeCheck, scopeCheckInputSchema } from './scope-tools';
import { baselineCaptureInputSchema, baselineCaptureTool } from './baseline-tools';
import {
  reqAddTool,
  reqAddToolSchema,
  reqChangeTool,
  reqChangeToolSchema,
  reqCoverageTool,
  reqCoverageToolSchema,
  reqLinkTaskTool,
  reqLinkTaskToolSchema,
} from './requirements-tools';
import {
  dependencyToolSchema,
  execPlanViewTool,
  planViewToolSchema,
  taskBlockTool,
  taskBlockToolSchema,
  taskDependencyTool,
  taskSplitTool,
  taskSplitToolSchema,
  taskStartCommandTool,
  taskStartCommandToolSchema,
} from './planning-tools';
import { sessionStartTool, sessionStartToolSchema } from './session-tools';
import { ledgerProjectsTool, projectsToolSchema } from './project-tools';
import {
  execLedgerReconcileTool,
  execLedgerReconcileToolSchema,
  journalDoneTool,
  journalDoneToolSchema,
  journalFailTool,
  journalFailToolSchema,
  journalStartTool,
  journalStartToolSchema,
} from './journal-tools';

/**
 * PE-2's five mandatory ledger tools plus PE-3's two closing tools (plan §7, §8).
 * They are deliberately *thin*: the schemas are the ones the service validates
 * against, and every rule (blocking defaults, dedup, soft-closure refusal, the
 * one-event-per-mutation invariant, the thirteen gate rules) lives in
 * `@forgepm/core/src/exec`. A tool that re-implements a rule is a rule with two
 * answers, so there is exactly one place where each is decided.
 *
 * All of them are gated on `module: 'exec'`: while the module is off, `tools/list`
 * does not contain them at all — the feature is invisible, not merely refused.
 */

type Tool = Parameters<ToolRegistry['register']>[0];

const actorOf = (ctx: McpCallContext): Actor => ctx.actor as unknown as Actor;

/**
 * The scopes of the ledger tools (plan §4.0 vs. §7/B.7).
 *
 * §4.0 names the ledger's own scopes (`ledger:read` / `ledger:write`) and
 * §7's B.7 acceptance tests the generic ones (a read-only key must not
 * write). Both are honoured: a key needs EITHER the generic scope OR the
 * ledger one. Nothing that worked yesterday stops working, and a key may now
 * be granted the ledger alone — an agent that drives the ledger without
 * holding the product's general `write` is the point of the separate scope.
 */
const READ_SCOPES = ['read', 'ledger:read'];
const WRITE_SCOPES = ['write', 'ledger:write'];

export function buildExecTools(db: Db): Tool[] {
  return [
    {
      name: 'exec_task_start',
      description:
        'Start a ledger task: creates the work item, the exec_tasks row and one exec_criteria row per acceptance criterion in ONE transaction, plus the audit row and the ledger event. Criteria are refused unless they are checkable (an observable outcome plus a reference such as test:NAME, file:path, commit:sha or cmd:…). allowed_paths is required because the scope of a task must be knowable from its start, not from its diff.',
      inputSchema: taskStartInputSchema,
      scopes: WRITE_SCOPES,
      annotations: { destructiveHint: false, idempotentHint: true },
      module: 'exec',
      handler: (args, ctx) => startTask(db, actorOf(ctx), args) as Promise<unknown>,
    },
    {
      name: 'session_start',
      description:
        'Resume a project session: mark interrupted actions unknown and return six priority-ordered sections within the configured byte budget.',
      inputSchema: sessionStartToolSchema,
      scopes: READ_SCOPES,
      annotations: { readOnlyHint: false, destructiveHint: false },
      module: 'exec',
      handler: (args, ctx) => sessionStartTool(db, actorOf(ctx), args),
    },
    {
      name: 'ledger_projects',
      description:
        'List the projects this key can use, with the id, key, name and status to pass as project_ref. Call it first when you do not know the project key. Read-only.',
      inputSchema: projectsToolSchema,
      scopes: READ_SCOPES,
      annotations: { readOnlyHint: true },
      module: 'exec',
      handler: (args, ctx) => ledgerProjectsTool(db, actorOf(ctx), args),
    },
    {
      name: 'journal_start',
      description:
        'Record an action and its Git pre-state before performing it. Unsettled entries lock agent writes; only an exact idempotent retry is allowed.',
      inputSchema: journalStartToolSchema,
      scopes: WRITE_SCOPES,
      annotations: { destructiveHint: false, idempotentHint: false },
      module: 'exec',
      handler: (args, ctx) => journalStartTool(db, actorOf(ctx), args),
    },
    {
      name: 'journal_done',
      description:
        'Settle a verified journal action as done; provide a result reference and optional note. Inspect unknown actions before settling.',
      inputSchema: journalDoneToolSchema,
      scopes: WRITE_SCOPES,
      annotations: { destructiveHint: false },
      module: 'exec',
      handler: (args, ctx) => journalDoneTool(db, actorOf(ctx), args),
    },
    {
      name: 'journal_fail',
      description:
        'Settle a journal action as failed with an auditable note; use this after inspecting an unknown outcome.',
      inputSchema: journalFailToolSchema,
      scopes: WRITE_SCOPES,
      annotations: { destructiveHint: false },
      module: 'exec',
      handler: (args, ctx) => journalFailTool(db, actorOf(ctx), args),
    },
    {
      name: 'exec_ledger_reconcile',
      description:
        'Compare closed-task file hashes, gate stamps, stale facts, open journals, and reported changed_files against read-only measurements.',
      inputSchema: execLedgerReconcileToolSchema,
      scopes: READ_SCOPES,
      annotations: { readOnlyHint: false, destructiveHint: false },
      module: 'exec',
      handler: (args, ctx) => execLedgerReconcileTool(db, actorOf(ctx), args),
    },
    {
      name: 'req_add',
      description:
        'Record a measurable requirement with an exact quote, source, kind and priority. Vague wording is rejected with the same checkability rules as acceptance criteria. req_ids on task creation are declarations only; use req_link_task to bind an acceptance criterion for gate coverage. Explicit contradictions can create a blocking design-gap item and a human question.',
      inputSchema: reqAddToolSchema,
      scopes: WRITE_SCOPES,
      annotations: { destructiveHint: false },
      module: 'exec',
      handler: (args, ctx) => reqAddTool(db, actorOf(ctx), args),
    },
    {
      name: 'req_link_task',
      description:
        'Link one or more existing acceptance criteria on a task to an active requirement. This criterion req_id link is the only requirement coverage relationship; task req_ids declarations never satisfy the gate.',
      inputSchema: reqLinkTaskToolSchema,
      scopes: WRITE_SCOPES,
      annotations: { destructiveHint: false },
      module: 'exec',
      handler: (args, ctx) => reqLinkTaskTool(db, actorOf(ctx), args),
    },
    {
      name: 'req_change',
      description:
        'Change an active requirement using a new exact quote and checkable wording. Linked criteria are reopened as pending, historical evidence is preserved, dependent decisions become needs_revisit, and each linked completed task is reopened with a blocking item.',
      inputSchema: reqChangeToolSchema,
      scopes: WRITE_SCOPES,
      annotations: { destructiveHint: false },
      module: 'exec',
      handler: (args, ctx) => reqChangeTool(db, actorOf(ctx), args),
    },
    {
      name: 'req_coverage',
      description:
        'Show each active requirement, task declarations, linked criteria, evidence counts and its coverage state. A declaration assigns work but does not satisfy acceptance-criterion coverage.',
      inputSchema: reqCoverageToolSchema,
      scopes: READ_SCOPES,
      annotations: { readOnlyHint: true },
      module: 'exec',
      handler: (args, ctx) => reqCoverageTool(db, actorOf(ctx), args),
    },
    {
      name: 'fact_record',
      description:
        "Record project knowledge with its kind, source, and any referenced files. `kind:'fact', source:'agent_guess'` is rejected; use `kind:'assumption'` for a guess. ForgePM reads and hashes files itself; duplicate keys supersede the previous row without deleting history.",
      inputSchema: factRecordToolSchema,
      scopes: WRITE_SCOPES,
      annotations: { destructiveHint: false },
      module: 'exec',
      handler: (args, ctx) => factRecordTool(db, actorOf(ctx), args),
    },
    {
      name: 'fact_query',
      description:
        'Search project facts and assumptions. Stale rows remain visible with status=stale and a warning; never treat a stale value as current truth.',
      inputSchema: factQueryToolSchema,
      scopes: READ_SCOPES,
      annotations: { readOnlyHint: true },
      module: 'exec',
      handler: (args, ctx) => factQueryTool(db, actorOf(ctx), args),
    },
    {
      name: 'fact_verify',
      description:
        'Re-read a fact’s referenced files and compare their current hashes. A mismatch marks the fact stale, moves dependent active decisions to needs_revisit, and files blocking items; a matching explicit verification may reactivate only the fact, not its decisions.',
      inputSchema: factVerifyToolSchema,
      scopes: WRITE_SCOPES,
      annotations: { destructiveHint: false },
      module: 'exec',
      handler: (args, ctx) => factVerifyTool(db, actorOf(ctx), args),
    },
    {
      name: 'fact_promote',
      description:
        'Human-only confirmation that promotes an assumption to an active fact. A reason is mandatory; file, commit, and command references are checked before promotion. Agents must ask a human instead.',
      inputSchema: factPromoteToolSchema,
      scopes: ['ledger:decide'],
      annotations: { destructiveHint: false },
      module: 'exec',
      handler: (args, ctx) => factPromoteTool(db, actorOf(ctx), args),
    },
    {
      name: 'task_split',
      description:
        'Split a parent task into checkable child tasks in one transaction. Each child has its own allowed_paths and criteria; req_ids are declarations only. depends_on accepts child keys or existing task refs, and any self/two/three-task cycle is rejected.',
      inputSchema: taskSplitToolSchema,
      scopes: WRITE_SCOPES,
      annotations: { destructiveHint: false },
      module: 'exec',
      handler: (args, ctx) => taskSplitTool(db, actorOf(ctx), args),
    },
    {
      name: 'task_start',
      description:
        'Move an existing not-started task into progress only when every dependency is done. A refusal lists the exact pending_deps; blocked and awaiting-human states remain distinct.',
      inputSchema: taskStartCommandToolSchema,
      scopes: WRITE_SCOPES,
      annotations: { destructiveHint: false },
      module: 'exec',
      handler: (args, ctx) => taskStartCommandTool(db, actorOf(ctx), args),
    },
    {
      name: 'task_block',
      description:
        'Persist a task blocker. reason, blocked_on_kind and unblock_condition are required; task/question/decision blockers also require a resolvable blocked_on_ref. Blocked tasks move out of the started work-item category.',
      inputSchema: taskBlockToolSchema,
      scopes: WRITE_SCOPES,
      annotations: { destructiveHint: false },
      module: 'exec',
      handler: (args, ctx) => taskBlockTool(db, actorOf(ctx), args),
    },
    {
      name: 'exec_link_dep',
      description:
        'Add a directed task dependency. Self, two-task and longer cycles are rejected with DEPENDENCY_CYCLE; starting a task with any pending dependency is refused.',
      inputSchema: dependencyToolSchema,
      scopes: WRITE_SCOPES,
      annotations: { destructiveHint: false },
      module: 'exec',
      handler: (args, ctx) => taskDependencyTool(db, actorOf(ctx), args),
    },
    {
      name: 'exec_plan_view',
      description:
        'Read the complete project task tree, dependencies, declared requirements, linked criteria, blockers and uncovered requirements without needing another context call. blocked and awaiting_human are distinct display states.',
      inputSchema: planViewToolSchema,
      scopes: READ_SCOPES,
      annotations: { readOnlyHint: true },
      module: 'exec',
      handler: (args, ctx) => execPlanViewTool(db, actorOf(ctx), args),
    },
    {
      name: 'ledger_add_open_item',
      description:
        'File an open item (question, commitment, incomplete requirement, bug…) against a task. `commitment` and `incomplete_requirement` are blocking by default; un-blocking one needs `why_not_blocking` of at least 40 characters. A near-duplicate of an item already on the task is answered with CONFLICT and the existing code — file it once, then update that row.',
      inputSchema: openItemToolSchema,
      scopes: WRITE_SCOPES,
      annotations: { destructiveHint: false },
      module: 'exec',
      handler: (args, ctx) => addOpenItem(db, actorOf(ctx), args) as Promise<unknown>,
    },
    {
      name: 'ledger_resolve_item',
      description:
        'Move an open item to another status. A soft closure (`deferred`, `accepted`, `wont_fix`, `not_applicable`) of a **blocking** item is refused for an agent with LEDGER_TRANSITION_NOT_ALLOWED — only a human may downgrade a blocker, and every closure needs a note of at least 20 characters. `resolved` is always available, and `open` reopens.',
      inputSchema: resolveToolSchema,
      scopes: WRITE_SCOPES,
      annotations: { destructiveHint: false },
      module: 'exec',
      handler: (args, ctx) => resolveItem(db, actorOf(ctx), args) as Promise<unknown>,
    },
    {
      name: 'ledger_list_open',
      description:
        'List a task’s open items, active ones first, then the closed ones as history. `active_only` (default true) restricts the list to what is still open. Nothing here deletes: a resolved item stays visible as evidence of what was decided.',
      inputSchema: listToolSchema,
      scopes: READ_SCOPES,
      annotations: { readOnlyHint: true },
      module: 'exec',
      handler: (args, ctx) => listOpen(db, actorOf(ctx), args) as Promise<unknown>,
    },
    {
      name: 'exec_ledger_status',
      description:
        'What stands between this task and a submission: blocking open items, criteria without evidence, unanswered blocking questions, decisions awaiting approval, and requirements no task covers. Answers with the same projection the panel renders, so tool and UI cannot disagree. With no task in the project it returns { empty: true } and says which tool to call.',
      inputSchema: statusToolSchema,
      scopes: READ_SCOPES,
      annotations: { readOnlyHint: true },
      module: 'exec',
      handler: (args, ctx) => ledgerStatus(db, actorOf(ctx), args) as Promise<unknown>,
    },
    {
      name: 'ledger_add_evidence',
      description:
        'Attach proof to a criterion — a claim without proof is refused. The ref must be something an auditor can read: file:<path> (inside exec.allowed_repo_roots), commit:<sha>:<path>, ci:<run_id>:<job>, test:<name> or cmd:<journal id>. A path that does not exist is EVIDENCE_UNAVAILABLE, a test log without a result line is EVIDENCE_INVALID, and secrets in the text are masked before anything is written. The evidence, the criterion it verifies and the ledger event commit together.',
      inputSchema: evidenceToolSchema,
      scopes: WRITE_SCOPES,
      annotations: { destructiveHint: false },
      module: 'exec',
      handler: (args, ctx) => addEvidenceTool(db, actorOf(ctx), args) as Promise<unknown>,
    },
    {
      name: 'ledger_record_decision',
      description:
        'Record a decision with its reasons: the options, the one you chose, the rationale (>= 40 chars) and what it touches. The RISK IS NOT YOURS — the policy table decides it. A decision that needs approval is stored as pending and the answer says do_not_apply_until_human_approval:true: do not apply it before a human approves. A decision the policy denies is not recorded at all.',
      inputSchema: decisionToolSchema,
      scopes: WRITE_SCOPES,
      annotations: { destructiveHint: false },
      module: 'exec',
      handler: (args, ctx) => recordDecisionTool(db, actorOf(ctx), args) as Promise<unknown>,
    },
    {
      name: 'ledger_ask_human',
      description:
        'Ask the human a question the ledger keeps: the options, your recommendation, why it matters, and the impact of EACH option (one entry per option). A blocking question moves the task to awaiting_review and there is NO timeout: silence is not approval, and the gate keeps refusing until the question is answered.',
      inputSchema: questionToolSchema,
      scopes: WRITE_SCOPES,
      annotations: { destructiveHint: false },
      module: 'exec',
      handler: (args, ctx) => askHumanTool(db, actorOf(ctx), args) as Promise<unknown>,
    },
    {
      name: 'exec_policy_check',
      description:
        'Ask the policy what it thinks of an action BEFORE you do it: { action_kind, target, reversible, command? }. The answer is the level (auto | review | approval | deny), the rules that produced it, and the tool to call next. It creates no decision and approves nothing; a DENIED action appends only a blocked-attempt ledger event. Use it before a change when the policy outcome is unclear — the same table decides, so the answer cannot be a guess.',
      inputSchema: policyCheckToolSchema,
      scopes: READ_SCOPES,
      annotations: { destructiveHint: false },
      module: 'exec',
      handler: (args, ctx) => policyCheckTool(db, actorOf(ctx), args) as Promise<unknown>,
    },
    {
      name: 'exec_submit_exit_report',
      description:
        'Submit the exit report for a task. The report is strict: every field must be present, and each of the eight "none" fields must either list its entries or be confirmed empty with none_confirmed.<field>=true — a dropped field is refused, never assumed. Every incomplete item, assumption, risk, unrun test and out-of-scope finding is filed as an open item with source=exit_report, in the same transaction. tests_executed[].evidence_id must be the id of an evidence row that really exists for this task.',
      inputSchema: exitReportToolSchema,
      scopes: WRITE_SCOPES,
      annotations: { destructiveHint: false },
      module: 'exec',
      handler: (args, ctx) => submitExitReportTool(db, actorOf(ctx), args) as Promise<unknown>,
    },
    {
      name: 'baseline_capture',
      description:
        'Fetch and parse CI logs for the server-measured task start and current commit SHAs. No SHA, test result or log is accepted from the caller; ForgePM never runs repository code. Missing or mismatched logs return BASELINE_UNAVAILABLE and Rule 12 fails closed.',
      inputSchema: baselineCaptureInputSchema,
      scopes: WRITE_SCOPES,
      annotations: { destructiveHint: false, idempotentHint: false },
      module: 'exec',
      handler: (args, ctx) => baselineCaptureTool(db, actorOf(ctx), args),
    },
    {
      name: 'scope_check',
      description:
        'Measure changed paths from the server-captured task start commit, or from a hash-only start manifest when Git is unavailable. This is read-only; exit-report changed_files claims are ignored. Out-of-scope edits and deletions need an explicit human resolution.',
      inputSchema: scopeCheckInputSchema,
      scopes: READ_SCOPES,
      annotations: { readOnlyHint: true },
      module: 'exec',
      handler: (args, ctx) => scopeCheck(db, actorOf(ctx), args),
    },
    {
      name: 'review_task',
      description: 'Run the read-only adversarial review over the task ledger and allowed-root Git diff. Findings are recorded as reviewer open items; the model cannot edit files or work items.',
      inputSchema: reviewTaskInputSchema,
      scopes: ['review'],
      annotations: { destructiveHint: false, idempotentHint: false },
      module: 'exec',
      handler: (args, ctx) => reviewTask(db, actorOf(ctx), args),
    },
    {
      name: 'exec_task_complete',
      description:
        'Close a task — the single gate. Runs the thirteen finalization rules against the ledger, writes the gate stamp, and only then moves the task to done (closed_at is set, open items are NOT closed for you). A refusal is an answer, not an error: { ok:false, blocked_by:[{rule,ref,title,needed,tool_to_call}] }. The completion report comes from the ledger, never from the message.',
      inputSchema: completeToolSchema,
      scopes: WRITE_SCOPES,
      annotations: { destructiveHint: false },
      module: 'exec',
      handler: (args, ctx) => completeTaskTool(db, actorOf(ctx), args) as Promise<unknown>,
    },
  ];
}

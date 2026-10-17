/**
 * Cross-cutting enums (plan §1). These are the only source of truth for
 * API, MCP and the panel.
 */
export const WORK_ITEM_TYPES = ['task', 'bug', 'feature_task', 'improvement', 'refactor', 'research', 'chore'] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

export const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const STATE_CATEGORIES = ['backlog', 'unstarted', 'started', 'in_review', 'completed', 'canceled'] as const;
export type StateCategory = (typeof STATE_CATEGORIES)[number];

export const ACTOR_TYPES = ['user', 'agent', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const ORG_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const PROJECT_ROLES = ['lead', 'contributor', 'viewer'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const WORK_ITEM_SOURCES = ['manual', 'planner', 'code_review', 'refactor_review', 'github'] as const;
export type WorkItemSource = (typeof WORK_ITEM_SOURCES)[number];

export const APPROVAL_POLICIES = ['manual', 'auto_low_risk'] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

export const REVIEW_ISSUE_POLICIES = ['record_only', 'human_approval', 'auto_high_severity'] as const;
export type ReviewIssuePolicy = (typeof REVIEW_ISSUE_POLICIES)[number];

export const API_KEY_SCOPES = [
  'read',
  'write',
  'plan',
  'plan_approve',
  'plan_apply',
  'review',
  'github',
  'admin',
  // Execution-control ledger (docs/EXECUTION_CONTROL_PLAN.md §4.0). `ledger:read`
  // and `ledger:write` are the agent's scopes; `ledger:decide` is HUMAN-ONLY
  // (approvals, waivers, gate re-run, fact promotion, reopen) — see D-040.
  'ledger:read',
  'ledger:write',
  'ledger:decide',
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'dead'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const PLAN_STATUSES = [
  'generating',
  'needs_clarification',
  'ready',
  'approved',
  'applying',
  'applied',
  'generation_failed',
  'apply_failed',
  'canceled',
  'superseded',
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const FINDING_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_STATUSES = ['open', 'dismissed', 'accepted', 'issue_created', 'not_seen', 'fixed'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

// ---- Execution control (docs/EXECUTION_CONTROL_PLAN.md §4) ----

export const EXEC_TASK_STATUSES = ['not_started', 'in_progress', 'awaiting_review', 'blocked', 'done'] as const;
export type ExecTaskStatus = (typeof EXEC_TASK_STATUSES)[number];

export const EXEC_CRITERION_STATUSES = ['pending', 'verified', 'waived'] as const;
export type ExecCriterionStatus = (typeof EXEC_CRITERION_STATUSES)[number];

export const EXEC_EVIDENCE_KINDS = ['test_output', 'diff', 'file', 'command_output', 'manual_check'] as const;
export type ExecEvidenceKind = (typeof EXEC_EVIDENCE_KINDS)[number];

export const EXEC_OPEN_ITEM_TYPES = [
  'incomplete_requirement',
  'commitment',
  'assumption',
  'bug',
  'risk',
  'test_gap',
  'design_gap',
  'suggestion',
  'out_of_scope',
] as const;
export type ExecOpenItemType = (typeof EXEC_OPEN_ITEM_TYPES)[number];

export const EXEC_OPEN_ITEM_SOURCES = ['agent', 'exit_report', 'reviewer', 'human', 'hook'] as const;
export type ExecOpenItemSource = (typeof EXEC_OPEN_ITEM_SOURCES)[number];

export const EXEC_OPEN_ITEM_STATUSES = [
  'open',
  'resolved',
  'accepted',
  'deferred',
  'wont_fix',
  'blocked',
  'awaiting_human',
  'not_applicable',
] as const;
export type ExecOpenItemStatus = (typeof EXEC_OPEN_ITEM_STATUSES)[number];

/** Statuses only a human may put a blocking item into (rule I-3). */
export const EXEC_HUMAN_ONLY_CLOSURES = ['accepted', 'deferred', 'wont_fix'] as const;
/** Statuses that keep a task out of `done`. */
export const EXEC_OPEN_ITEM_ACTIVE = ['open', 'blocked', 'awaiting_human'] as const;

export const EXEC_RISK_LEVELS = ['auto', 'review', 'approval', 'deny'] as const;
export type ExecRiskLevel = (typeof EXEC_RISK_LEVELS)[number];

export const EXEC_APPROVAL_STATES = ['not_required', 'pending', 'approved', 'rejected'] as const;
export type ExecApprovalState = (typeof EXEC_APPROVAL_STATES)[number];

export const EXEC_DECISION_STATUSES = ['proposed', 'active', 'superseded', 'needs_revisit'] as const;
export type ExecDecisionStatus = (typeof EXEC_DECISION_STATUSES)[number];

/** Categories the risk policy knows about (plan §F table + appendix §1.5). */
export const POLICY_CATEGORIES = [
  'none',
  'internal_edit',
  'add_module',
  'local_bugfix',
  'default_change',
  'add_test',
  'public_api',
  'db_schema',
  'auth',
  'secret',
  'deps_add',
  'deps_upgrade',
  'delete_data',
  'delete_file',
  'config_deploy',
  'ci',
  'migration',
  'destructive_command',
  'rename_bulk',
  'scope_expansion',
  'drop_requirement',
  'waive_requirement',
  'baseline_change',
  'fact_promote_from_guess',
  'cancel_subtask',
  'write_secret',
  'delete_root_folder',
] as const;
export type PolicyCategory = (typeof POLICY_CATEGORIES)[number];

export const EXEC_TOUCH_CATEGORIES = [
  'none',
  'internal_edit',
  'add_module',
  'local_bugfix',
  'default_change',
  'add_test',
  'public_api',
  'db_schema',
  'auth',
  'secret',
  'deps_add',
  'deps_upgrade',
  'delete_data',
  'delete_file',
  'config_deploy',
  'ci',
  'migration',
  'destructive_command',
  'rename_bulk',
  'scope_expansion',
  'drop_requirement',
  'waive_requirement',
  'baseline_change',
  'fact_promote_from_guess',
  'cancel_subtask',
] as const;
export type ExecTouchCategory = (typeof EXEC_TOUCH_CATEGORIES)[number];

export const EXEC_QUESTION_STATUSES = ['open', 'answered', 'canceled'] as const;
export type ExecQuestionStatus = (typeof EXEC_QUESTION_STATUSES)[number];

export const EXEC_REVIEW_VERDICTS = ['pass', 'fail'] as const;
export type ExecReviewVerdict = (typeof EXEC_REVIEW_VERDICTS)[number];

export const EXEC_REQ_KINDS = ['functional', 'non_functional'] as const;
export type ExecRequirementKind = (typeof EXEC_REQ_KINDS)[number];

export const EXEC_REQ_SOURCES = ['user_message', 'doc', 'human', 'agent_derived'] as const;
export type ExecRequirementSource = (typeof EXEC_REQ_SOURCES)[number];

export const EXEC_REQ_STATUSES = ['active', 'changed', 'dropped'] as const;
export type ExecRequirementStatus = (typeof EXEC_REQ_STATUSES)[number];

export const EXEC_FACT_KINDS = ['fact', 'assumption'] as const;
export type ExecFactKind = (typeof EXEC_FACT_KINDS)[number];

export const EXEC_FACT_SOURCES = ['code', 'docs', 'human', 'tool_output', 'agent_guess'] as const;
export type ExecFactSource = (typeof EXEC_FACT_SOURCES)[number];

export const EXEC_FACT_STATUSES = ['active', 'stale', 'rejected', 'superseded'] as const;
export type ExecFactStatus = (typeof EXEC_FACT_STATUSES)[number];

export const EXEC_JOURNAL_STATUSES = ['started', 'done', 'failed', 'unknown'] as const;
export type ExecJournalStatus = (typeof EXEC_JOURNAL_STATUSES)[number];

export const EXEC_BLOCKED_ON_KINDS = ['task', 'question', 'decision', 'external'] as const;
export type ExecBlockedOnKind = (typeof EXEC_BLOCKED_ON_KINDS)[number];

/** Tool families used by session_start / the write-lock (PE-10 rule). */
export const EXEC_READ_TOOLS = [
  'exec_ledger_status',
  'ledger_list_open',
  'exec_plan_view',
  'req_coverage',
  'fact_query',
  'scope_check',
  'exec_policy_check',
  'session_start',
  'exec_ledger_reconcile',
] as const;
export type ExecReadTool = (typeof EXEC_READ_TOOLS)[number];

import type { ColumnType, Generated } from 'kysely';

/**
 * jsonb columns map to parsed JS values via the pg driver.
 * We keep them as `unknown` at the typed layer; services cast to concrete
 * schemas on read (validation with Zod happens in the service layer).
 */
export type Jsonb = ColumnType<unknown, unknown, unknown>;
/** created_at: read-only; DB default on insert. */
export type Timestamp = ColumnType<Date, Date | string | undefined, never>;
/** updated_at: writable on insert and update. */
export type UpdatableTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface OutboxTable {
  id: string;
  organization_id: string | null;
  topic: string;
  payload: Jsonb;
  created_at: Timestamp;
  dispatched_at: Date | null;
  attempts: Generated<number>;
  last_error: string | null;
}

export interface JobsTable {
  id: string;
  organization_id: string | null;
  queue: string;
  type: string;
  status: Generated<'queued' | 'running' | 'succeeded' | 'failed' | 'dead'>;
  payload: Jsonb;
  attempts: Generated<number>;
  error: string | null;
  heartbeat_at: Date | null;
  outbox_id: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Timestamp;
  updated_at: UpdatableTimestamp;
}

export interface IdempotencyKeysTable {
  id: string;
  actor_id: string;
  operation: string;
  key: string;
  request_hash: string;
  // status: stored | in_progress (plan §3b-3)
  status: Generated<'stored' | 'in_progress'>;
  response: Jsonb | null;
  response_status: number | null;
  expires_at: Date;
  created_at: Timestamp;
}

export interface SettingsTable {
  id: string;
  // scope: system | organization | project (plan §5.7)
  scope: 'system' | 'organization' | 'project';
  scope_id: string | null;
  key: string;
  value: Jsonb;
  created_at: Timestamp;
  updated_at: UpdatableTimestamp;
}

// ---- Phase 1: identity, tenancy, projects, secrets, audit (plan §12 §B) ----

export interface OrganizationsTable {
  id: string;
  name: string;
  slug: string;
  created_at: Timestamp;
  updated_at: UpdatableTimestamp;
  deleted_at: Date | null;
}

export interface UsersTable {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  locale: Generated<'en' | 'fa'>;
  timezone: Generated<string>;
  status: Generated<'active' | 'disabled'>;
  created_at: Timestamp;
  updated_at: UpdatableTimestamp;
  deleted_at: Date | null;
}

export interface MembershipsTable {
  id: string;
  organization_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  created_at: Timestamp;
}

export interface SessionsTable {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  ip: string | null;
  user_agent: string | null;
  created_at: Timestamp;
}

export interface AgentsTable {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  status: Generated<'active' | 'disabled'>;
  created_at: Timestamp;
  updated_at: UpdatableTimestamp;
  deleted_at: Date | null;
}

export interface ApiKeysTable {
  id: string;
  organization_id: string;
  owner_user_id: string | null;
  agent_id: string | null;
  key_hash: string;
  prefix: string;
  name: Generated<string>;
  scopes: Generated<string[]>;
  project_ids: Generated<string[]>;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_at: Timestamp;
  updated_at: UpdatableTimestamp;
}

export interface SecretsTable {
  id: string;
  organization_id: string;
  scope: 'system' | 'project' | 'module';
  name: string;
  ciphertext: Buffer;
  key_version: Generated<number>;
  last4: string | null;
  created_at: Timestamp;
  updated_at: UpdatableTimestamp;
}

export interface ProjectsTable {
  id: string;
  organization_id: string;
  key: string;
  name: string;
  description: string | null;
  status: Generated<'active' | 'archived'>;
  priority: Generated<'none' | 'low' | 'medium' | 'high' | 'urgent'>;
  start_date: string | null;
  target_date: string | null;
  next_item_number: Generated<number>;
  archived_at: Date | null;
  created_at: Timestamp;
  updated_at: UpdatableTimestamp;
  deleted_at: Date | null;
}

export interface ProjectMembersTable {
  id: string;
  project_id: string;
  user_id: string;
  role: 'lead' | 'contributor' | 'viewer';
  created_at: Timestamp;
}

export interface AuditEventsTable {
  id: string;
  organization_id: string;
  actor_type: 'user' | 'agent' | 'system';
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  summary: Jsonb | null;
  request_id: string | null;
  created_at: Timestamp;
}

// ---- Phase 2: work items, features, milestones (plan §6, §12 §C) ----

export interface WorkflowStatesTable {
  id: string;
  organization_id: string;
  project_id: string;
  name: string;
  category: 'backlog' | 'unstarted' | 'started' | 'in_review' | 'completed' | 'canceled';
  position: Generated<number>;
  created_at: Timestamp;
  updated_at: UpdatableTimestamp;
}

export interface MilestonesTable {
  id: string;
  organization_id: string;
  project_id: string;
  name: string;
  target_date: string | null;
  status: Generated<'open' | 'closed'>;
  created_at: Timestamp;
  updated_at: UpdatableTimestamp;
  deleted_at: Date | null;
}

export interface FeaturesTable {
  id: string;
  organization_id: string;
  project_id: string;
  key: string;
  title: string;
  description: string | null;
  lifecycle_status: Generated<'proposed' | 'planned' | 'in_progress' | 'in_validation' | 'released' | 'deprecated'>;
  target_release: string | null;
  milestone_id: string | null;
  acceptance_criteria: Jsonb;
  created_at: Timestamp;
  updated_at: UpdatableTimestamp;
  deleted_at: Date | null;
}

export interface WorkItemsTable {
  id: string;
  organization_id: string;
  project_id: string;
  number: number;
  type: 'task' | 'bug' | 'feature_task' | 'improvement' | 'refactor' | 'research' | 'chore';
  title: string;
  description: string | null;
  state_id: string;
  priority: Generated<'none' | 'low' | 'medium' | 'high' | 'urgent'>;
  assignee_user_id: string | null;
  assignee_agent_id: string | null;
  reporter_id: string | null;
  estimate: string | null;
  due_date: string | null;
  parent_id: string | null;
  feature_id: string | null;
  milestone_id: string | null;
  acceptance_criteria: Jsonb;
  source: Generated<'manual' | 'planner' | 'code_review' | 'refactor_review' | 'github'>;
  plan_id: string | null;
  exec_task_id: string | null;
  created_at: Timestamp;
  updated_at: UpdatableTimestamp;
  deleted_at: Date | null;
}

export interface WorkItemRelationsTable {
  id: string;
  from_id: string;
  to_id: string;
  type: 'blocks' | 'relates_to' | 'duplicates';
  created_at: Timestamp;
}

export interface LabelsTable {
  id: string;
  organization_id: string;
  project_id: string;
  name: string;
  color: string;
  created_at: Timestamp;
}

export interface WorkItemLabelsTable {
  work_item_id: string;
  label_id: string;
}

export interface CommentsTable {
  id: string;
  work_item_id: string;
  author_type: 'user' | 'agent' | 'system';
  author_id: string;
  kind: Generated<'comment' | 'ai_report'>;
  body: string;
  edited_at: Date | null;
  created_at: Timestamp;
  deleted_at: Date | null;
}

export interface SavedViewsTable {
  id: string;
  organization_id: string;
  project_id: string;
  owner_id: string;
  name: string;
  filter: Jsonb;
  shared: Generated<boolean>;
  created_at: Timestamp;
  updated_at: UpdatableTimestamp;
}

export interface WorkItemExternalLinksTable {
  id: string;
  work_item_id: string;
  kind: 'pr' | 'commit' | 'branch' | 'issue' | 'url';
  external_id: string;
  url: string;
  metadata: Jsonb;
  remote_version: string | null;
  last_synced_at: Date | null;
  created_at: Timestamp;
}

export interface FeatureDependenciesTable {
  id: string;
  feature_id: string;
  depends_on_id: string;
  created_at: Timestamp;
}

// ---- Phase 3: AI providers, plans, approvals (plan §7, §12 §D) ----

export interface AiProvidersTable {
  id: string;
  organization_id: string;
  name: string;
  kind: 'anthropic' | 'openai' | 'openai_compatible' | 'fake';
  base_url: string | null;
  encrypted_key: Buffer | null;
  key_last4: string | null;
  default_model: string | null;
  enabled: Generated<boolean>;
  created_at: Timestamp;
  updated_at: UpdatableTimestamp;
}

export interface AiCallsTable {
  id: string;
  organization_id: string;
  provider_id: string;
  model: string;
  purpose: string;
  tokens_in: number | null;
  tokens_out: number | null;
  latency_ms: number | null;
  status: 'ok' | 'error';
  created_at: Timestamp;
}

export interface PlansTable {
  id: string;
  organization_id: string;
  project_id: string;
  goal: string;
  status:
    | 'generating'
    | 'needs_clarification'
    | 'ready'
    | 'approved'
    | 'applying'
    | 'applied'
    | 'generation_failed'
    | 'apply_failed'
    | 'canceled'
    | 'superseded';
  current_revision_id: string | null;
  created_by: string;
  created_at: Timestamp;
  updated_at: UpdatableTimestamp;
}

export interface PlanRevisionsTable {
  id: string;
  plan_id: string;
  revision_no: number;
  content: Jsonb;
  validation: Jsonb | null;
  created_by: string;
  created_at: Timestamp;
}

export interface ReplanSuggestionsTable {
  id: string;
  organization_id: string;
  plan_id: string;
  reason: string;
  details: Jsonb;
  status: Generated<'open' | 'dismissed'>;
  created_at: Timestamp;
}

export interface ApprovalRequestsTable {
  id: string;
  organization_id: string;
  project_id: string | null;
  requested_by: string;
  action: string;
  payload: Jsonb;
  risk: Generated<'low' | 'sensitive'>;
  status: Generated<'pending' | 'approved' | 'rejected' | 'canceled'>;
  decided_by: string | null;
  decided_at: Date | null;
  reason: string | null;
  created_at: Timestamp;
}

// ---- Phase 4: MCP (plan §8, §12 §E) ----

export interface McpToolCallsTable {
  id: string;
  organization_id: string;
  api_key_id: string | null;
  tool: string;
  input_summary: Jsonb;
  outcome: 'ok' | 'error' | 'pending_approval';
  error_code: string | null;
  duration_ms: number | null;
  request_id: string | null;
  created_at: Timestamp;
}

export interface McpServersTable {
  id: string;
  organization_id: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string | null;
  url: string | null;
  allowed_tools: Generated<string[]>;
  enabled: Generated<boolean>;
  created_at: Timestamp;
}

// ---- Phase 5: GitHub (plan §9, §12 §F) ----

export interface RepositoriesTable {
  id: string;
  organization_id: string;
  provider: Generated<string>;
  external_id: string;
  full_name: string;
  installation_id: string | null;
  default_branch: string | null;
  created_at: Timestamp;
}

export interface ProjectRepositoriesTable {
  project_id: string;
  repository_id: string;
  organization_id: string;
  created_at: Timestamp;
}

export interface PullRequestsTable {
  id: string;
  repository_id: string;
  external_id: string;
  number: number;
  title: string;
  state: string;
  draft: Generated<boolean>;
  author: string | null;
  head_sha: string | null;
  body: string | null;
  merged_at: Date | null;
  created_at: Timestamp;
  updated_at: UpdatableTimestamp;
}

export interface CommitsTable {
  id: string;
  repository_id: string;
  external_id: string;
  sha: string;
  message: string | null;
  author: string | null;
  authored_at: Date | null;
}

export interface BranchesTable {
  id: string;
  repository_id: string;
  name: string;
  sha: string | null;
  created_at: Timestamp;
  deleted_at: Date | null;
}

export interface WebhookDeliveriesTable {
  id: string;
  organization_id: string;
  delivery_id: string;
  event: string;
  payload: Jsonb;
  received_at: Timestamp;
  processed_at: Date | null;
  status: Generated<'received' | 'processing' | 'done' | 'failed'>;
}

export interface ExternalIssueLinksTable {
  id: string;
  work_item_id: string;
  repository_id: string;
  issue_number: number;
  sync_origin: Generated<string>;
  remote_version: string | null;
  last_synced_at: Date | null;
  local_modified_at: Date | null;
  created_at: Timestamp;
}

export interface ReleasesTable {
  id: string;
  repository_id: string;
  tag: string;
  published_at: Date | null;
  notes_ref: string | null;
  created_at: Timestamp;
}

// ---- Phase 6: reviews (plan §10, §12 §G) ----

export interface ReviewRunsTable {
  id: string;
  organization_id: string;
  project_id: string;
  repository_id: string | null;
  kind: 'code' | 'refactor';
  target: Jsonb;
  status: Generated<'queued' | 'running' | 'completed' | 'failed' | 'truncated' | 'canceled'>;
  attempt: Generated<number>;
  config_snapshot: Jsonb;
  // helper: the validated run input (filtered hunks + commit snapshot) — §12 column-additive rule
  input: Jsonb;
  stats: Jsonb;
  created_at: Timestamp;
  updated_at: UpdatableTimestamp;
}

export interface ReviewFindingsTable {
  id: string;
  organization_id: string;
  project_id: string;
  run_id: string;
  first_run_id: string;
  last_seen_run_id: string;
  scope_key: string;
  fingerprint: string;
  category: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  // pg `numeric` round-trips as string via the driver; services cast.
  confidence: unknown;
  file: string;
  line_start: number | null;
  line_end: number | null;
  title: string;
  description: string;
  why_it_matters: string | null;
  suggestion: string | null;
  evidence: string | null;
  impact: string | null;
  effort: string | null;
  risk: string | null;
  status: Generated<'open' | 'dismissed' | 'accepted' | 'issue_created' | 'not_seen' | 'fixed'>;
  unseen_streak: Generated<number>;
  work_item_id: string | null;
  created_at: Timestamp;
  updated_at: UpdatableTimestamp;
}

export interface CodeStructureIndexTable {
  id: string;
  repository_id: string;
  commit_sha: string;
  index: Jsonb;
  stats: Jsonb;
  created_at: Timestamp;
}

// ---- Execution control ledger (docs/EXECUTION_CONTROL_PLAN.md §4, migration 0010) ----

export interface ExecCodeSeqTable {
  project_id: string;
  prefix: 'T' | 'C' | 'OI' | 'D' | 'Q' | 'F' | 'REQ' | 'AJ';
  seq: Generated<number>;
}

export interface ExecRequirementsTable {
  id: string;
  organization_id: string;
  project_id: string | null;
  code: string;
  text: string;
  quote: string;
  source: 'user_message' | 'doc' | 'human' | 'agent_derived';
  source_ref: string | null;
  kind: Generated<'functional' | 'non_functional'>;
  status: Generated<'active' | 'changed' | 'dropped'>;
  priority: Generated<'none' | 'low' | 'medium' | 'high' | 'urgent'>;
  drop_reason: string | null;
  dropped_by: 'human' | 'system' | null;
  created_at: Timestamp;
  updated_at: UpdatableTimestamp;
}

export interface ExecTasksTable {
  id: string;
  organization_id: string;
  project_id: string;
  work_item_id: string;
  gate_stamp_id: string | null;
  code: string;
  title: string;
  description: string | null;
  status: 'not_started' | 'in_progress' | 'awaiting_review' | 'blocked' | 'done';
  parent_id: string | null;
  start_ref: string | null;
  tree_hash_start: string | null;
  allowed_paths: Jsonb;
  blocked_on_kind: 'task' | 'question' | 'decision' | 'external' | null;
  blocked_on_ref: string | null;
  blocked_reason: string | null;
  unblock_condition: string | null;
  created_at: Timestamp;
  updated_at: UpdatableTimestamp;
  closed_at: Date | null;
}

export interface ExecTaskDepsTable {
  task_id: string;
  depends_on_task_id: string;
  created_at: Timestamp;
}

export interface ExecCriteriaTable {
  id: string;
  task_id: string;
  req_id: string | null;
  code: string;
  text: string;
  status: Generated<'pending' | 'verified' | 'waived'>;
  verified_at: Date | null;
  waiver_approval_id: string | null;
  created_at: Timestamp;
}

export interface ExecEvidenceTable {
  id: string;
  organization_id: string;
  task_id: string;
  criterion_id: string | null;
  kind: 'test_output' | 'diff' | 'file' | 'command_output' | 'manual_check';
  ref: string;
  summary: string;
  payload: string | null;
  sha256: string | null;
  size_bytes: number | null;
  meta: Jsonb | null;
  recorded_by: string;
  created_at: Timestamp;
}

export interface ExecOpenItemsTable {
  id: string;
  organization_id: string;
  task_id: string;
  code: string;
  title: string;
  detail: string | null;
  type:
    | 'incomplete_requirement'
    | 'commitment'
    | 'assumption'
    | 'bug'
    | 'risk'
    | 'test_gap'
    | 'design_gap'
    | 'suggestion'
    | 'out_of_scope';
  blocks_completion: boolean;
  why_not_blocking: string | null;
  source: 'agent' | 'exit_report' | 'reviewer' | 'human' | 'hook';
  status: 'open' | 'resolved' | 'accepted' | 'deferred' | 'wont_fix' | 'blocked' | 'awaiting_human' | 'not_applicable';
  resolution_note: string | null;
  resolved_by: 'agent' | 'human' | null;
  related_ref: string | null;
  created_at: Timestamp;
  updated_at: UpdatableTimestamp;
}

export interface ExecDecisionsTable {
  id: string;
  organization_id: string;
  task_id: string;
  code: string;
  title: string;
  context: string;
  options: Jsonb;
  selected: string;
  rationale: string;
  touches: string[];
  reversible: boolean;
  risk_level: 'auto' | 'review' | 'approval';
  approval_state: 'not_required' | 'pending' | 'approved' | 'rejected';
  approval_id: string | null;
  applied_at: Date | null;
  status: Generated<'proposed' | 'active' | 'superseded' | 'needs_revisit'>;
  review_trigger: Jsonb | null;
  created_at: Timestamp;
  updated_at: UpdatableTimestamp;
}

export interface ExecQuestionsTable {
  id: string;
  organization_id: string;
  project_id?: string;
  task_id: string;
  code: string;
  question: string;
  options: Jsonb;
  recommendation: string;
  why_it_matters: string;
  impact: Jsonb | null;
  blocking: boolean;
  status: Generated<'open' | 'answered' | 'canceled'>;
  answer: string | null;
  answered_by: string | null;
  approval_id: string | null;
  created_at: Timestamp;
  answered_at: Date | null;
}

export interface ExecReviewsTable {
  id: string;
  organization_id: string;
  task_id: string;
  round: number;
  review_run_id: string | null;
  verdict: 'pass' | 'fail';
  findings: Jsonb;
  checked: Jsonb;
  tree_hash: string;
  input_meta: Jsonb | null;
  created_at: Timestamp;
}

export interface ExecReportsTable {
  id: string;
  organization_id: string;
  task_id: string;
  payload: Jsonb;
  status: Generated<'submitted' | 'gate_passed' | 'gate_failed'>;
  created_at: Timestamp;
  updated_at: UpdatableTimestamp;
}

export interface ExecGateChecksTable {
  id: string;
  organization_id: string;
  task_id: string;
  report_id: string;
  ok: boolean;
  blocked_by: Jsonb;
  gate_version: number;
  tree_hash: string;
  run_source: string;
  created_at: Timestamp;
}

export interface ExecFactsTable {
  id: string;
  organization_id: string;
  project_id: string;
  code: string;
  key: string;
  value: string;
  kind: 'fact' | 'assumption';
  source: 'code' | 'docs' | 'human' | 'tool_output' | 'agent_guess';
  source_ref: string | null;
  files: Jsonb;
  file_hashes: Jsonb;
  verified_at: Date | null;
  status: Generated<'active' | 'stale' | 'rejected' | 'superseded'>;
  superseded_by: string | null;
  created_at: Timestamp;
}

export interface ExecFactDecisionsTable {
  fact_id: string;
  decision_id: string;
  created_at: Timestamp;
}

export interface ExecBaselineTestsTable {
  id: string;
  task_id: string;
  test_name: string;
  result_at_start: 'pass' | 'fail' | 'skip';
  assertion_count: number | null;
  source: 'ci' | 'human';
  approval_id: string | null;
  provenance: Jsonb | null;
  captured_at: Timestamp;
}

export interface ExecActionJournalTable {
  id: string;
  organization_id: string;
  task_id: string;
  code: string;
  action: string;
  target: string | null;
  idempotent: boolean;
  expected_effect: string;
  pre_state_ref: string | null;
  status: Generated<'started' | 'done' | 'failed' | 'unknown'>;
  started_at: Timestamp;
  finished_at: Date | null;
  result_ref: string | null;
  note: string | null;
}

export interface ExecEventsTable {
  id: string;
  organization_id: string;
  task_id: string | null;
  entity: string;
  entity_id: string | null;
  entity_code: string | null;
  action: string;
  actor_type: 'agent' | 'human' | 'system';
  actor_id: string;
  tool: string | null;
  payload: Jsonb | null;
  created_at: Timestamp;
}

export interface ExecReqTasksTable {
  req_id: string;
  task_id: string;
  criterion_ids: Jsonb;
  created_at: Timestamp;
}

export interface DB {
  outbox: OutboxTable;
  jobs: JobsTable;
  idempotency_keys: IdempotencyKeysTable;
  settings: SettingsTable;
  organizations: OrganizationsTable;
  users: UsersTable;
  memberships: MembershipsTable;
  sessions: SessionsTable;
  agents: AgentsTable;
  api_keys: ApiKeysTable;
  secrets: SecretsTable;
  projects: ProjectsTable;
  project_members: ProjectMembersTable;
  audit_events: AuditEventsTable;
  workflow_states: WorkflowStatesTable;
  milestones: MilestonesTable;
  features: FeaturesTable;
  work_items: WorkItemsTable;
  work_item_relations: WorkItemRelationsTable;
  labels: LabelsTable;
  work_item_labels: WorkItemLabelsTable;
  comments: CommentsTable;
  saved_views: SavedViewsTable;
  work_item_external_links: WorkItemExternalLinksTable;
  feature_dependencies: FeatureDependenciesTable;
  ai_providers: AiProvidersTable;
  ai_calls: AiCallsTable;
  plans: PlansTable;
  plan_revisions: PlanRevisionsTable;
  replan_suggestions: ReplanSuggestionsTable;
  approval_requests: ApprovalRequestsTable;
  mcp_tool_calls: McpToolCallsTable;
  mcp_servers: McpServersTable;
  repositories: RepositoriesTable;
  project_repositories: ProjectRepositoriesTable;
  pull_requests: PullRequestsTable;
  commits: CommitsTable;
  branches: BranchesTable;
  webhook_deliveries: WebhookDeliveriesTable;
  external_issue_links: ExternalIssueLinksTable;
  releases: ReleasesTable;
  review_runs: ReviewRunsTable;
  review_findings: ReviewFindingsTable;
  code_structure_index: CodeStructureIndexTable;
  exec_code_seq: ExecCodeSeqTable;
  exec_requirements: ExecRequirementsTable;
  exec_req_tasks: ExecReqTasksTable;
  exec_tasks: ExecTasksTable;
  exec_task_deps: ExecTaskDepsTable;
  exec_criteria: ExecCriteriaTable;
  exec_evidence: ExecEvidenceTable;
  exec_open_items: ExecOpenItemsTable;
  exec_decisions: ExecDecisionsTable;
  exec_questions: ExecQuestionsTable;
  exec_reviews: ExecReviewsTable;
  exec_reports: ExecReportsTable;
  exec_gate_checks: ExecGateChecksTable;
  exec_facts: ExecFactsTable;
  exec_fact_decisions: ExecFactDecisionsTable;
  exec_baseline_tests: ExecBaselineTestsTable;
  exec_action_journal: ExecActionJournalTable;
  exec_events: ExecEventsTable;
}

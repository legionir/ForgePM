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
  status: 'generating' | 'needs_clarification' | 'ready' | 'approved' | 'applying' | 'applied' | 'generation_failed' | 'apply_failed' | 'canceled' | 'superseded';
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
}

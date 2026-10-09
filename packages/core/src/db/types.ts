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
}

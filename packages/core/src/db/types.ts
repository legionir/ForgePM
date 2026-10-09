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

export interface DB {
  outbox: OutboxTable;
  jobs: JobsTable;
  idempotency_keys: IdempotencyKeysTable;
  settings: SettingsTable;
}

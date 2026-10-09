export const MIGRATION_0001_INFRA = `
-- 0001_infra — Phase 0 infrastructure tables (plan §4.5, §12).
-- Forward-only. Written to run on PostgreSQL 14+ (CI/production use 16);
-- PG16-only NULLS NOT DISTINCT is replaced by an equivalent expression
-- partial-unique index, expressly allowed by plan §12.
-- UUIDv7 primary keys are generated in the application; no DB default.

-- outbox: single transactional place services enqueue work (plan §3b-3).
CREATE TABLE IF NOT EXISTS outbox (
  id              uuid PRIMARY KEY,
  organization_id uuid,
  topic           text NOT NULL,
  payload         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  dispatched_at   timestamptz,
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx
  ON outbox (dispatched_at NULLS FIRST, created_at);

-- jobs: status/recovery registry (plan §3b-3).
CREATE TABLE IF NOT EXISTS jobs (
  id              uuid PRIMARY KEY,
  organization_id uuid,
  queue           text NOT NULL,
  type            text NOT NULL,
  status          text NOT NULL
    CHECK (status IN ('queued','running','succeeded','failed','dead')),
  payload         jsonb NOT NULL,
  attempts        integer NOT NULL DEFAULT 0,
  error           text,
  heartbeat_at    timestamptz,
  outbox_id       uuid REFERENCES outbox(id) ON DELETE SET NULL,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_status_queue_idx ON jobs (status, queue);
-- one job row per outbox row: makes dispatcher claiming idempotent (plan §3b-3).
CREATE UNIQUE INDEX IF NOT EXISTS jobs_outbox_uniq ON jobs (outbox_id);

-- idempotency_keys: unique per (actor_id, operation, key) (plan §3b-3).
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id              uuid PRIMARY KEY,
  actor_id        text NOT NULL,
  operation       text NOT NULL,
  key             text NOT NULL,
  request_hash    text NOT NULL,
  status          text NOT NULL
    CHECK (status IN ('stored','in_progress')),
  response        jsonb,
  response_status integer,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idempotency_actor_op_key_uniq
  ON idempotency_keys (actor_id, operation, key);

-- settings: three-level registry system <- organization <- project (§5.7).
CREATE TABLE IF NOT EXISTS settings (
  id              uuid PRIMARY KEY,
  scope           text NOT NULL CHECK (scope IN ('system','organization','project')),
  scope_id        uuid,
  key             text NOT NULL,
  value           jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (scope = 'system' AND scope_id IS NULL) OR
    (scope IN ('organization','project') AND scope_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS settings_scope_key_uniq
  ON settings (scope, COALESCE(scope_id::text, ''), key);
`;

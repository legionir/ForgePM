# ForgePM — Data Model (Schema Contract)

> Contract per EXECUTION_PLAN §3b-5 and §12. The complete DDL below precedes
> the migrations of each phase; `npm run schema:check` compares the **live**
> database schema against this document for every table that currently exists.
> Tables are grouped by the phase that creates them.
>
> Conventions (§12): UUIDv7 PKs generated in the application; top-level tables
> carry `organization_id`, `created_at`, `updated_at` (UTC, `timestamptz`) and
> where needed `deleted_at`; dependent tables derive the org from their parent;
> `projects` has `UNIQUE(id, organization_id)` and project-bearing tables use
> the composite FK `(project_id, organization_id) -> projects(id, organization_id)`;
> unique constraints over nullable columns use **partial/expression unique
> indexes** (portable equivalent of `UNIQUE NULLS NOT DISTINCT`, explicitly
> allowed by §12); soft-delete tables keep uniqueness partial with
> `deleted_at IS NULL`; JSONB only for genuinely semi-structured data.
>
> Migration 0001 (Phase 0) implements exactly the four tables in §A.
> Everything after it is forward-only and lands with its phase.

## §A — Infrastructure (Phase 0, migration `0001_infra`)

```sql
CREATE TABLE outbox (
  id              uuid PRIMARY KEY,
  organization_id uuid,
  topic           text NOT NULL,
  payload         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  dispatched_at   timestamptz,
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text
);
CREATE INDEX outbox_pending_idx ON outbox (dispatched_at NULLS FIRST, created_at);

CREATE TABLE jobs (
  id              uuid PRIMARY KEY,
  organization_id uuid,
  queue           text NOT NULL,
  type            text NOT NULL,
  status          text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','dead')),
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
CREATE INDEX jobs_status_queue_idx ON jobs (status, queue);
CREATE UNIQUE INDEX jobs_outbox_uniq ON jobs (outbox_id);

CREATE TABLE idempotency_keys (
  id              uuid PRIMARY KEY,
  actor_id        text NOT NULL,
  operation       text NOT NULL,
  key             text NOT NULL,
  request_hash    text NOT NULL,
  status          text NOT NULL CHECK (status IN ('stored','in_progress')),
  response        jsonb,
  response_status integer,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idempotency_actor_op_key_uniq ON idempotency_keys (actor_id, operation, key);

CREATE TABLE settings (
  id              uuid PRIMARY KEY,
  scope           text NOT NULL CHECK (scope IN ('system','organization','project')),
  scope_id        uuid,
  key             text NOT NULL,
  value           jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'system' AND scope_id IS NULL) OR (scope IN ('organization','project') AND scope_id IS NOT NULL))
);
CREATE UNIQUE INDEX settings_scope_key_uniq ON settings (scope, COALESCE(scope_id::text, ''), key);
```

## §B — Core identity & projects (Phase 1, migration `0002_core`)

```sql
CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX organizations_slug_uniq ON organizations (slug) WHERE deleted_at IS NULL;

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('en','fa')),
  timezone text NOT NULL DEFAULT 'Asia/Tehran',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX users_email_uniq ON users (lower(email));

CREATE TABLE memberships (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  ip inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_token_idx ON sessions (token_hash);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE agents (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (organization_id, name)
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  owner_user_id uuid REFERENCES users(id),
  agent_id uuid REFERENCES agents(id),
  key_hash text NOT NULL,
  prefix text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  project_ids uuid[] NOT NULL DEFAULT '{}',
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_user_id IS NOT NULL) != (agent_id IS NOT NULL)),
  UNIQUE (key_hash)
);

CREATE TABLE secrets (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  scope text NOT NULL CHECK (scope IN ('system','project','module')),
  name text NOT NULL,
  ciphertext bytea NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  last4 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, scope, name)
);
-- value never appears in any API response (§12)

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  key text NOT NULL CHECK (key ~ '^[A-Z]{3,5}$'),
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  priority text NOT NULL DEFAULT 'none' CHECK (priority IN ('none','low','medium','high','urgent')),
  start_date date,
  target_date date,
  next_item_number integer NOT NULL DEFAULT 1,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, organization_id),          -- target of composite FKs
  UNIQUE (organization_id, key)
);

CREATE TABLE project_members (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('lead','contributor','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, user_id),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  actor_type text NOT NULL CHECK (actor_type IN ('user','agent','system')),
  actor_id uuid NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  summary jsonb,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_org_created_idx ON audit_events (organization_id, created_at DESC);
CREATE INDEX audit_resource_idx ON audit_events (resource_type, resource_id);
```

## §C — Work items, features, milestones (Phase 2, migrations `0003_domain`, `0004_search`)

```sql
CREATE TABLE workflow_states (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  name text NOT NULL,
  category text NOT NULL CHECK (category IN ('backlog','unstarted','started','in_review','completed','canceled')),
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name),
  UNIQUE (id, organization_id),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id)
);

CREATE TABLE milestones (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  name text NOT NULL,
  target_date date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, organization_id),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id)
);
CREATE INDEX milestones_project_idx ON milestones (project_id, target_date);

CREATE TABLE features (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  key text NOT NULL,
  title text NOT NULL,
  description text,
  lifecycle_status text NOT NULL DEFAULT 'proposed'
    CHECK (lifecycle_status IN ('proposed','planned','in_progress','in_validation','released','deprecated')),
  target_release text,
  milestone_id uuid,
  acceptance_criteria jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (project_id, key),
  UNIQUE (id, organization_id),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id),
  FOREIGN KEY (milestone_id, organization_id) REFERENCES milestones(id, organization_id)
);

CREATE TABLE work_items (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  number integer NOT NULL,
  type text NOT NULL CHECK (type IN ('task','bug','feature_task','improvement','refactor','research','chore')),
  title text NOT NULL CHECK (char_length(title) <= 500),
  description text,
  state_id uuid NOT NULL,
  priority text NOT NULL DEFAULT 'none' CHECK (priority IN ('none','low','medium','high','urgent')),
  assignee_user_id uuid,
  assignee_agent_id uuid,
  reporter_id uuid REFERENCES users(id),
  estimate numeric,
  due_date date,
  parent_id uuid,
  feature_id uuid,
  milestone_id uuid,
  acceptance_criteria jsonb NOT NULL DEFAULT '[]',
  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','planner','code_review','refactor_review','github')),
  plan_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK ((assignee_user_id IS NULL) OR (assignee_agent_id IS NULL)),
  UNIQUE (project_id, number),
  UNIQUE (id, organization_id),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id),
  FOREIGN KEY (state_id, organization_id) REFERENCES workflow_states(id, organization_id),
  FOREIGN KEY (feature_id, organization_id) REFERENCES features(id, organization_id),
  FOREIGN KEY (milestone_id, organization_id) REFERENCES milestones(id, organization_id),
  FOREIGN KEY (parent_id) REFERENCES work_items(id)
);
CREATE INDEX workitems_state_idx ON work_items (project_id, state_id, priority);
CREATE INDEX workitems_assignee_user_idx ON work_items (assignee_user_id);
CREATE INDEX workitems_assignee_agent_idx ON work_items (assignee_agent_id);
-- §12: list indexes start with project_id/organization_id and cover the cursor
-- order (created_at DESC, id DESC); the partial form skips soft-deleted rows.
-- Added by 0009_perf after the phase-7 load run (P-02) proved the org-wide
-- index alone degraded the 200k-item project list.
CREATE INDEX workitems_project_cursor_idx ON work_items (project_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX workitems_org_cursor_undel_idx ON work_items (organization_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;

CREATE TABLE work_item_relations (
  id uuid PRIMARY KEY,
  from_id uuid NOT NULL REFERENCES work_items(id),
  to_id uuid NOT NULL REFERENCES work_items(id),
  type text NOT NULL CHECK (type IN ('blocks','relates_to','duplicates')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_id, to_id, type),
  CHECK (from_id <> to_id)
);

CREATE TABLE labels (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  name text NOT NULL,
  color text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name),
  UNIQUE (id, organization_id),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id)
);

CREATE TABLE work_item_labels (
  work_item_id uuid NOT NULL REFERENCES work_items(id),
  label_id uuid NOT NULL REFERENCES labels(id),
  PRIMARY KEY (work_item_id, label_id)
);

CREATE TABLE comments (
  id uuid PRIMARY KEY,
  work_item_id uuid NOT NULL REFERENCES work_items(id),
  author_type text NOT NULL CHECK (author_type IN ('user','agent','system')),
  author_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment','ai_report')),
  body text NOT NULL,
  edited_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX comments_item_idx ON comments (work_item_id, created_at);

CREATE TABLE saved_views (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  owner_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  filter jsonb NOT NULL,
  shared boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id)
);

CREATE TABLE work_item_external_links (
  id uuid PRIMARY KEY,
  work_item_id uuid NOT NULL REFERENCES work_items(id),
  kind text NOT NULL CHECK (kind IN ('pr','commit','branch','issue','url')),
  external_id text NOT NULL,
  url text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  remote_version text,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_item_id, kind, external_id)
);

-- full-text search (§1, Phase 2): generated column + GIN
ALTER TABLE work_items ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(description,''))) STORED;
CREATE INDEX workitems_search_idx ON work_items USING GIN (search_vector);
```

## §D — Planner & AI (Phase 3, migration `0005_planner`)

```sql
CREATE TABLE ai_providers (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('anthropic','openai','openai_compatible','fake')),
  base_url text,
  encrypted_key bytea,
  key_last4 text,
  default_model text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE ai_calls (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  provider_id uuid NOT NULL REFERENCES ai_providers(id),
  model text NOT NULL,
  purpose text NOT NULL,
  tokens_in integer,
  tokens_out integer,
  latency_ms integer,
  status text NOT NULL CHECK (status IN ('ok','error')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_calls_org_created_idx ON ai_calls (organization_id, created_at);

CREATE TABLE plans (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  goal text NOT NULL,
  status text NOT NULL CHECK (status IN
    ('generating','needs_clarification','ready','approved','applying','applied',
     'generation_failed','apply_failed','canceled','superseded')),
  current_revision_id uuid,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id)
);

CREATE TABLE plan_revisions (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES plans(id),
  revision_no integer NOT NULL,
  content jsonb NOT NULL,
  validation jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, revision_no)
);
ALTER TABLE plans ADD CONSTRAINT plans_current_revision_fk
  FOREIGN KEY (current_revision_id) REFERENCES plan_revisions(id);

CREATE TABLE replan_suggestions (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES plans(id),
  reason text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE approval_requests (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid,
  requested_by text NOT NULL,
  action text NOT NULL,
  payload jsonb NOT NULL,
  risk text NOT NULL DEFAULT 'sensitive' CHECK (risk IN ('low','sensitive')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','canceled')),
  decided_by text,
  decided_at timestamptz,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id)
);
CREATE INDEX approvals_project_status_idx ON approval_requests (project_id, status);
```

## §E — MCP (Phase 4, migration `0006_mcp`)

```sql
CREATE TABLE mcp_tool_calls (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  api_key_id uuid,
  tool text NOT NULL,
  input_summary jsonb NOT NULL DEFAULT '{}',
  outcome text NOT NULL CHECK (outcome IN ('ok','error','pending_approval')),
  error_code text,
  duration_ms integer,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mcp_calls_key_created_idx ON mcp_tool_calls (api_key_id, created_at);

CREATE TABLE mcp_servers (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  transport text NOT NULL CHECK (transport IN ('stdio','http')),
  command text,
  url text,
  allowed_tools text[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
```

## §F — GitHub (Phase 5, migration `0007_github`)

```sql
CREATE TABLE repositories (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  provider text NOT NULL DEFAULT 'github',
  external_id text NOT NULL,
  full_name text NOT NULL,
  installation_id text,
  default_branch text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id),
  UNIQUE (id, organization_id)
);

CREATE TABLE project_repositories (
  project_id uuid NOT NULL,
  repository_id uuid NOT NULL REFERENCES repositories(id),
  organization_id uuid NOT NULL,
  PRIMARY KEY (project_id, repository_id),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id)
);

CREATE TABLE pull_requests (
  id uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES repositories(id),
  external_id text NOT NULL,
  number integer NOT NULL,
  title text NOT NULL,
  state text NOT NULL,
  draft boolean NOT NULL DEFAULT false,
  author text,
  head_sha text,
  body text,
  merged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, external_id)
);

CREATE TABLE commits (
  id uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES repositories(id),
  external_id text NOT NULL,
  sha text NOT NULL,
  message text,
  author text,
  authored_at timestamptz,
  UNIQUE (repository_id, external_id)
);

CREATE TABLE branches (
  id uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES repositories(id),
  name text NOT NULL,
  sha text,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (repository_id, name)
);

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  delivery_id text NOT NULL,
  event text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processing','done','failed')),
  UNIQUE (delivery_id)
);

CREATE TABLE external_issue_links (
  id uuid PRIMARY KEY,
  work_item_id uuid NOT NULL REFERENCES work_items(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  issue_number integer NOT NULL,
  sync_origin text NOT NULL DEFAULT 'github',
  remote_version text,
  last_synced_at timestamptz,
  local_modified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, issue_number)
);

CREATE TABLE releases (
  id uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES repositories(id),
  tag text NOT NULL,
  published_at timestamptz,
  notes_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, tag)
);
```

## §G — Reviews (Phase 6, migration `0008_reviews`)

```sql
CREATE TABLE review_runs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  repository_id uuid REFERENCES repositories(id),
  kind text NOT NULL CHECK (kind IN ('code','refactor')),
  target jsonb NOT NULL,            -- {"pr":N,"commit_sha":...}
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('queued','running','completed','failed','truncated','canceled')),
  attempt integer NOT NULL DEFAULT 1,
  config_snapshot jsonb NOT NULL DEFAULT '{}',
  input jsonb NOT NULL DEFAULT '{}',   -- helper: filtered hunks + commit snapshot for this run
  stats jsonb NOT NULL DEFAULT '{}', -- {truncated,discarded,partition_cursor,...}
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id)
);
CREATE INDEX runs_project_created_idx ON review_runs (project_id, created_at);

CREATE TABLE review_findings (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES review_runs(id),
  first_run_id uuid NOT NULL REFERENCES review_runs(id),
  last_seen_run_id uuid NOT NULL REFERENCES review_runs(id),
  scope_key text NOT NULL,
  fingerprint text NOT NULL,
  category text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info','low','medium','high','critical')),
  confidence numeric NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  file text NOT NULL,
  line_start integer,
  line_end integer,
  title text NOT NULL,
  description text NOT NULL,
  why_it_matters text,
  suggestion text,
  evidence text,
  impact text,
  effort text,
  risk text,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','dismissed','accepted','issue_created','not_seen','fixed')),
  unseen_streak integer NOT NULL DEFAULT 0,
  work_item_id uuid REFERENCES work_items(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, scope_key, fingerprint),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id)
);

CREATE TABLE code_structure_index (
  id uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES repositories(id),
  commit_sha text NOT NULL,
  index jsonb NOT NULL,             -- compressed analysis output
  stats jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, commit_sha)
);
```

## Growth & retention (§14)

`audit_events`, `mcp_tool_calls`, `ai_calls`, `webhook_deliveries` are
partitioned by month on `created_at` (or structured partition-ready) and pruned
by a nightly job according to `retention.*_days` settings. The DDL above is
their logical contract; the partitioned physical form preserves every column,
index and constraint listed.

## Column-additive rule

Agents may add helper columns but must never remove or re-mean a column listed
here (plan §12).

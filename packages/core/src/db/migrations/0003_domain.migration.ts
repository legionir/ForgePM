export const MIGRATION_0003_DOMAIN = `
-- 0003_domain — Phase 2 work items, features, milestones, relations, comments,
-- labels, saved views, external links (plan §6, DATA_MODEL §C).
-- Composite FK targets get UNIQUE(id, organization_id) per §3b-2.

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
CREATE INDEX workitems_org_created_idx ON work_items (organization_id, created_at DESC, id DESC);

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

-- feature_dependencies (plan §6.4): feature -> feature, dedup per pair.
CREATE TABLE feature_dependencies (
  id uuid PRIMARY KEY,
  feature_id uuid NOT NULL REFERENCES features(id),
  depends_on_id uuid NOT NULL REFERENCES features(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (feature_id, depends_on_id),
  CHECK (feature_id <> depends_on_id)
);

-- full-text search: title + description here; comments are folded into the
-- search via a trigger-free join query (§13 GET /search). A generated column
-- keeps title/description indexed by GIN without app-side maintenance.
ALTER TABLE work_items ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(description,''))) STORED;
CREATE INDEX workitems_search_idx ON work_items USING GIN (search_vector);
`;

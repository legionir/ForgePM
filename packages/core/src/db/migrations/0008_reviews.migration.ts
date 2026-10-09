export const MIGRATION_0008_REVIEWS = `
-- 0008_reviews — Phase 6 shared review engine + Code/Refactor Review (plan §10, §12 §G).
-- Matches the pre-declared Schema Contract §G exactly (pnpm schema:check).

CREATE TABLE review_runs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  repository_id uuid REFERENCES repositories(id),
  kind text NOT NULL CHECK (kind IN ('code','refactor')),
  target jsonb NOT NULL,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('queued','running','completed','failed','truncated','canceled')),
  attempt integer NOT NULL DEFAULT 1,
  config_snapshot jsonb NOT NULL DEFAULT '{}',
  input jsonb NOT NULL DEFAULT '{}',
  stats jsonb NOT NULL DEFAULT '{}',
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
  index jsonb NOT NULL,
  stats jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, commit_sha)
);
`;

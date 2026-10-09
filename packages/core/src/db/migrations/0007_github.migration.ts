export const MIGRATION_0007_GITHUB = `
-- 0007_github — Phase 5 optional GitHub integration (plan §9, §12 §F).
-- Core never imports this module; the tables exist regardless.

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
  repository_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, repository_id),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id),
  FOREIGN KEY (repository_id, organization_id) REFERENCES repositories(id, organization_id)
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
CREATE INDEX pull_requests_repo_number_idx ON pull_requests (repository_id, number);

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
`;

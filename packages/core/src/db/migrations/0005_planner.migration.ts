export const MIGRATION_0005_PLANNER = `
-- 0005_planner — Phase 3 AI provider layer, plans, revisions, approvals,
-- ai_calls (plan §7, DATA_MODEL §D). Forward-only, PG14+.

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
  UNIQUE (id, organization_id),
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
  organization_id uuid NOT NULL REFERENCES organizations(id),
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
  UNIQUE (id, organization_id),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id)
);
CREATE INDEX approvals_project_status_idx ON approval_requests (project_id, status);
`;

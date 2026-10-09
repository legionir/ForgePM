export const MIGRATION_0002_CORE = `
-- 0002_core — Phase 1 identity, tenancy, projects, secrets, audit (plan §5.1, §12 §B).
-- Forward-only. Written PG14+ compatible (see DECISIONS D-002).

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
CREATE INDEX memberships_user_idx ON memberships (user_id);

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
  name text NOT NULL DEFAULT '',
  scopes text[] NOT NULL DEFAULT '{}',
  project_ids uuid[] NOT NULL DEFAULT '{}',
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_user_id IS NOT NULL) != (agent_id IS NOT NULL)),
  UNIQUE (key_hash)
);
CREATE INDEX api_keys_org_idx ON api_keys (organization_id);

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
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, key)
);
CREATE INDEX projects_org_created_idx ON projects (organization_id, created_at DESC, id DESC);

CREATE TABLE project_members (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('lead','contributor','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, user_id)
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
CREATE INDEX audit_org_created_idx ON audit_events (organization_id, created_at DESC, id DESC);
CREATE INDEX audit_resource_idx ON audit_events (resource_type, resource_id);
`;

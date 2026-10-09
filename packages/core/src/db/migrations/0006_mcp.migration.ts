export const MIGRATION_0006_MCP = `
-- 0006_mcp — Phase 4: MCP call log + external MCP servers (plan §8, §12 §E).

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
`;

export const MIGRATION_0010_EXEC = `
-- 0010_exec — Execution Control ledger (docs/EXECUTION_CONTROL_PLAN.md §4, PE-0).
-- 17 tables (+ the seq counter): the durable, agent-independent source of truth
-- for requirements, tasks, criteria, evidence, open items, decisions, questions,
-- reviews, the action journal and the finalization-gate stamp. Forward-only, PG14+.
--
-- Tamper resistance lives in the DB, not only in the app (golden rule):
--   * CHECK constraints encode the "agent may not close a blocking item with a
--     soft status" and "waive/drop needs a human approval" rules,
--   * an append-only trigger protects exec_events / exec_gate_checks /
--     exec_evidence, and exec_action_journal may only be settled (never
--     rewritten or deleted),
--   * UPDATE/DELETE is revoked from the application role when that role exists.

CREATE FUNCTION exec_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'exec: % is append-only', TG_TABLE_NAME USING ERRCODE = '42809';
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- code counters
CREATE TABLE exec_code_seq (
  project_id uuid NOT NULL REFERENCES projects(id),
  prefix text NOT NULL CHECK (prefix IN ('T','C','OI','D','Q','F','REQ','AJ')),
  seq integer NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, prefix)
);

-- ---------------------------------------------------------------- requirements (G)
CREATE TABLE exec_requirements (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid,
  code text NOT NULL,
  text text NOT NULL CHECK (char_length(text) >= 10),
  quote text NOT NULL CHECK (char_length(quote) >= 3),
  source text NOT NULL CHECK (source IN ('user_message','doc','human','agent_derived')),
  source_ref text,
  kind text NOT NULL DEFAULT 'functional' CHECK (kind IN ('functional','non_functional')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','changed','dropped')),
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('none','low','medium','high','urgent')),
  drop_reason text,
  dropped_by text CHECK (dropped_by IS NULL OR dropped_by IN ('human','system')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  CHECK (status <> 'dropped' OR (dropped_by IS NOT NULL AND drop_reason IS NOT NULL AND char_length(drop_reason) >= 10)),
  CHECK (source <> 'agent_derived' OR (source_ref IS NOT NULL AND char_length(source_ref) >= 3)),
  CHECK (source <> 'user_message' OR quote = left(text, char_length(quote)) OR text LIKE '%' || quote || '%')
);
CREATE UNIQUE INDEX exec_reqs_code_uniq ON exec_requirements (organization_id, code);
CREATE INDEX exec_reqs_project_status_idx ON exec_requirements (project_id, status);

-- ---------------------------------------------------------------- tasks (A + H)
CREATE TABLE exec_tasks (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  work_item_id uuid NOT NULL UNIQUE REFERENCES work_items(id),
  gate_stamp_id uuid,
  code text NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 5 AND 500),
  description text,
  status text NOT NULL DEFAULT 'not_started' CHECK (status IN
    ('not_started','in_progress','awaiting_review','blocked','done')),
  parent_id uuid REFERENCES exec_tasks(id),
  start_ref text,
  tree_hash_start text,
  allowed_paths jsonb NOT NULL DEFAULT '[]'::jsonb,
  blocked_on_kind text CHECK (blocked_on_kind IN ('task','question','decision','external')),
  blocked_on_ref uuid,
  blocked_reason text,
  unblock_condition text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  UNIQUE (id, organization_id),
  UNIQUE (project_id, code),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id),
  CHECK (status <> 'done' OR closed_at IS NOT NULL),
  CHECK (status NOT IN ('blocked','awaiting_review')
         OR (blocked_on_kind IS NOT NULL AND unblock_condition IS NOT NULL AND char_length(unblock_condition) >= 10)),
  CHECK (status <> 'blocked' OR blocked_reason IS NOT NULL)
);
CREATE INDEX exec_tasks_project_status_idx ON exec_tasks (project_id, status, id);
CREATE INDEX exec_tasks_parent_idx ON exec_tasks (parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE exec_task_deps (
  task_id uuid NOT NULL REFERENCES exec_tasks(id),
  depends_on_task_id uuid NOT NULL REFERENCES exec_tasks(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

CREATE TABLE exec_criteria (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES exec_tasks(id) ON DELETE CASCADE,
  req_id uuid REFERENCES exec_requirements(id),
  code text NOT NULL,
  text text NOT NULL CHECK (char_length(text) >= 25),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','waived')),
  verified_at timestamptz,
  waiver_approval_id uuid REFERENCES approval_requests(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, code),
  CHECK (status <> 'waived' OR waiver_approval_id IS NOT NULL),
  CHECK (status <> 'verified' OR verified_at IS NOT NULL)
);
CREATE INDEX exec_criteria_task_status_idx ON exec_criteria (task_id, status);

-- ---------------------------------------------------------------- evidence (B)
CREATE TABLE exec_evidence (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  task_id uuid NOT NULL REFERENCES exec_tasks(id),
  criterion_id uuid REFERENCES exec_criteria(id),
  kind text NOT NULL CHECK (kind IN ('test_output','diff','file','command_output','manual_check')),
  ref text NOT NULL CHECK (char_length(ref) BETWEEN 3 AND 500),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 20 AND 4000),
  payload text,
  sha256 text,
  size_bytes integer,
  meta jsonb,
  recorded_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (criterion_id IS NOT NULL OR summary <> ''),
  CHECK (size_bytes IS NULL OR size_bytes BETWEEN 1 AND 131072)
);
CREATE INDEX exec_evidence_criterion_idx ON exec_evidence (criterion_id);
CREATE INDEX exec_evidence_task_idx ON exec_evidence (task_id);

-- ---------------------------------------------------------------- open items (A)
CREATE TABLE exec_open_items (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  task_id uuid NOT NULL REFERENCES exec_tasks(id),
  code text NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 5 AND 500),
  detail text,
  type text NOT NULL CHECK (type IN ('incomplete_requirement','commitment','assumption','bug',
    'risk','test_gap','design_gap','suggestion','out_of_scope')),
  blocks_completion boolean NOT NULL DEFAULT false,
  why_not_blocking text,
  source text NOT NULL CHECK (source IN ('agent','exit_report','reviewer','human','hook')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','accepted','deferred',
    'wont_fix','blocked','awaiting_human','not_applicable')),
  resolution_note text,
  resolved_by text CHECK (resolved_by IN ('agent','human')),
  related_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, code),
  -- a closing status always needs a real note
  CHECK (status IN ('open','blocked','awaiting_human')
         OR (resolution_note IS NOT NULL AND char_length(resolution_note) >= 20 AND resolved_by IS NOT NULL)),
  -- I-3: soft closures of a blocking item are human-only
  CHECK (NOT (blocks_completion AND status IN ('accepted','deferred','wont_fix'))
         OR resolved_by = 'human'),
  -- downgrading blocks_completion of a required type needs a written reason
  CHECK (type NOT IN ('incomplete_requirement','commitment') OR blocks_completion OR why_not_blocking IS NOT NULL)
);
CREATE INDEX exec_open_items_task_status_idx ON exec_open_items (task_id, status, blocks_completion);
CREATE INDEX exec_open_items_open_idx ON exec_open_items (organization_id, status) WHERE status IN ('open','blocked','awaiting_human');

-- ---------------------------------------------------------------- decisions (F)
CREATE TABLE exec_decisions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  task_id uuid NOT NULL REFERENCES exec_tasks(id),
  code text NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 5 AND 500),
  context text NOT NULL,
  options jsonb NOT NULL,
  selected text NOT NULL,
  rationale text NOT NULL CHECK (char_length(rationale) >= 40),
  touches text[] NOT NULL DEFAULT '{none}',
  reversible boolean NOT NULL,
  risk_level text NOT NULL CHECK (risk_level IN ('auto','review','approval')),
  approval_state text NOT NULL CHECK (approval_state IN ('not_required','pending','approved','rejected')),
  approval_id uuid REFERENCES approval_requests(id),
  applied_at timestamptz,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','superseded','needs_revisit')),
  review_trigger jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, code),
  CHECK (risk_level <> 'approval' OR approval_id IS NOT NULL),
  CHECK (approval_state <> 'pending' OR risk_level = 'approval')
);
CREATE INDEX exec_decisions_task_idx ON exec_decisions (task_id, status);
CREATE INDEX exec_decisions_pending_idx ON exec_decisions (organization_id, approval_state)
  WHERE approval_state IN ('pending','rejected');

-- ---------------------------------------------------------------- questions (B)
CREATE TABLE exec_questions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  task_id uuid NOT NULL REFERENCES exec_tasks(id),
  code text NOT NULL,
  question text NOT NULL CHECK (char_length(question) BETWEEN 10 AND 2000),
  options jsonb NOT NULL,
  recommendation text NOT NULL,
  why_it_matters text NOT NULL CHECK (char_length(why_it_matters) >= 40),
  impact jsonb,
  blocking boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','canceled')),
  answer text,
  answered_by text,
  approval_id uuid REFERENCES approval_requests(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  UNIQUE (task_id, code),
  CHECK (status <> 'answered' OR (answer IS NOT NULL AND char_length(answer) >= 1 AND answered_at IS NOT NULL))
);
CREATE INDEX exec_questions_open_idx ON exec_questions (organization_id, status) WHERE status = 'open';

-- ---------------------------------------------------------------- reviews (E)
CREATE TABLE exec_reviews (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  task_id uuid NOT NULL REFERENCES exec_tasks(id),
  round integer NOT NULL CHECK (round >= 1),
  review_run_id uuid REFERENCES review_runs(id),
  verdict text NOT NULL CHECK (verdict IN ('pass','fail')),
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  checked jsonb NOT NULL DEFAULT '[]'::jsonb,
  tree_hash text NOT NULL,
  input_meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, round)
);

-- ---------------------------------------------------------------- exit reports (C)
CREATE TABLE exec_reports (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  task_id uuid NOT NULL REFERENCES exec_tasks(id),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','gate_passed','gate_failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX exec_reports_task_idx ON exec_reports (task_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------- gate stamp (C)
CREATE TABLE exec_gate_checks (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  task_id uuid NOT NULL REFERENCES exec_tasks(id),
  report_id uuid NOT NULL REFERENCES exec_reports(id),
  ok boolean NOT NULL,
  blocked_by jsonb NOT NULL DEFAULT '[]'::jsonb,
  gate_version integer NOT NULL,
  tree_hash text NOT NULL,
  run_source text NOT NULL DEFAULT 'none',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX exec_gate_task_created_idx ON exec_gate_checks (task_id, created_at DESC, id DESC);

ALTER TABLE exec_tasks ADD CONSTRAINT exec_tasks_gate_stamp_fk
  FOREIGN KEY (gate_stamp_id) REFERENCES exec_gate_checks(id);

-- ---------------------------------------------------------------- facts (I)
CREATE TABLE exec_facts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  code text NOT NULL,
  key text NOT NULL CHECK (char_length(key) BETWEEN 3 AND 120),
  value text NOT NULL CHECK (char_length(value) >= 5),
  kind text NOT NULL CHECK (kind IN ('fact','assumption')),
  source text NOT NULL CHECK (source IN ('code','docs','human','tool_output','agent_guess')),
  source_ref text,
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  file_hashes jsonb NOT NULL DEFAULT '[]'::jsonb,
  verified_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','stale','rejected','superseded')),
  superseded_by uuid REFERENCES exec_facts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, code),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id),
  CHECK (kind <> 'fact' OR source <> 'agent_guess'),
  CHECK (NOT (kind = 'fact' AND source IN ('code','tool_output')) OR source_ref IS NOT NULL),
  CHECK (status <> 'superseded' OR superseded_by IS NOT NULL)
);
CREATE UNIQUE INDEX exec_facts_active_key_uniq ON exec_facts (project_id, key) WHERE status = 'active';

CREATE TABLE exec_fact_decisions (
  fact_id uuid NOT NULL REFERENCES exec_facts(id),
  decision_id uuid NOT NULL REFERENCES exec_decisions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fact_id, decision_id)
);

-- ---------------------------------------------------------------- baseline (J)
CREATE TABLE exec_baseline_tests (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES exec_tasks(id),
  test_name text NOT NULL,
  result_at_start text NOT NULL CHECK (result_at_start IN ('pass','fail','skip')),
  assertion_count integer,
  source text NOT NULL CHECK (source IN ('ci','runner','human')),
  approval_id uuid REFERENCES approval_requests(id),
  provenance jsonb,
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, test_name),
  CHECK (source <> 'human' OR approval_id IS NOT NULL)
);

-- ---------------------------------------------------------------- journal (K)
CREATE TABLE exec_action_journal (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  task_id uuid NOT NULL REFERENCES exec_tasks(id),
  code text NOT NULL,
  action text NOT NULL CHECK (char_length(action) BETWEEN 3 AND 120),
  target text,
  idempotent boolean NOT NULL,
  expected_effect text NOT NULL CHECK (char_length(expected_effect) >= 10),
  pre_state_ref text,
  status text NOT NULL DEFAULT 'started' CHECK (status IN ('started','done','failed','unknown')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  result_ref text,
  note text,
  UNIQUE (task_id, code),
  CHECK (status = 'started' OR finished_at IS NOT NULL)
);
CREATE INDEX exec_journal_open_idx ON exec_action_journal (task_id, status) WHERE status IN ('started','unknown');

-- ---------------------------------------------------------------- events (A)
CREATE TABLE exec_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  task_id uuid,
  entity text NOT NULL,
  entity_id uuid,
  entity_code text,
  action text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('agent','human','system')),
  actor_id text NOT NULL,
  tool text,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX exec_events_task_ts_idx ON exec_events (task_id, created_at, id);
CREATE INDEX exec_events_org_ts_idx ON exec_events (organization_id, created_at DESC, id DESC);

-- link a ledger task back from the work item (column-additive, §12)
ALTER TABLE work_items ADD COLUMN exec_task_id uuid REFERENCES exec_tasks(id);
CREATE INDEX workitems_exec_task_idx ON work_items (exec_task_id) WHERE exec_task_id IS NOT NULL;

-- append-only enforcement for the audit surfaces (invariant I-2)
CREATE TRIGGER exec_events_append_only BEFORE UPDATE OR DELETE ON exec_events
  FOR EACH ROW EXECUTE FUNCTION exec_append_only();
CREATE TRIGGER exec_gate_checks_append_only BEFORE UPDATE OR DELETE ON exec_gate_checks
  FOR EACH ROW EXECUTE FUNCTION exec_append_only();
CREATE TRIGGER exec_evidence_append_only BEFORE UPDATE OR DELETE ON exec_evidence
  FOR EACH ROW EXECUTE FUNCTION exec_append_only();

-- A journal row is written when the action STARTS and settled exactly once
-- afterwards; the settlement may only change the outcome columns, never the
-- claim itself. Deleting a journalled action is impossible.
CREATE FUNCTION exec_journal_settle_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'exec: exec_action_journal rows may not be deleted' USING ERRCODE = '42809';
  END IF;
  IF OLD.status <> 'started' THEN
    RAISE EXCEPTION 'exec_action_journal % is already settled (%)', OLD.code, OLD.status USING ERRCODE = '42809';
  END IF;
  IF NEW.status = 'started' THEN
    RAISE EXCEPTION 'exec_action_journal % may not go back to started', OLD.code USING ERRCODE = '42809';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.code IS DISTINCT FROM OLD.code OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.idempotent IS DISTINCT FROM OLD.idempotent
     OR NEW.expected_effect IS DISTINCT FROM OLD.expected_effect
     OR NEW.pre_state_ref IS DISTINCT FROM OLD.pre_state_ref
     OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'exec_action_journal: only status/finished_at/result_ref/note may change' USING ERRCODE = '42809';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER exec_action_journal_settle_only BEFORE UPDATE OR DELETE ON exec_action_journal
  FOR EACH ROW EXECUTE FUNCTION exec_journal_settle_only();

-- When the deployment provisions a dedicated application role, the app can no
-- longer bypass the service layer to rewrite the ledger. Skip silently when the
-- role does not exist (test databases connect as the owner).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('forgepm_app','forgepm') LOOP
    EXECUTE format('REVOKE UPDATE, DELETE ON exec_events, exec_gate_checks, exec_evidence FROM %I', r.rolname);
    EXECUTE format('REVOKE DELETE ON exec_action_journal FROM %I', r.rolname);
  END LOOP;
END $$;
`;

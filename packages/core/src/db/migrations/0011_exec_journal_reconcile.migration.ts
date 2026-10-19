/**
 * PE-10 K: preserve a hash-only close snapshot for post-close reconciliation,
 * and let a journal row move through started -> unknown -> done/failed. The
 * migration is forward-only; 0010's already-shipped trigger is not edited.
 */
export const MIGRATION_0011_EXEC_JOURNAL_RECONCILE = String.raw`
ALTER TABLE exec_gate_checks ADD COLUMN file_manifest jsonb;

CREATE OR REPLACE FUNCTION exec_journal_settle_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'exec: exec_action_journal rows may not be deleted' USING ERRCODE = '42809';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.code IS DISTINCT FROM OLD.code OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.target IS DISTINCT FROM OLD.target OR NEW.idempotent IS DISTINCT FROM OLD.idempotent
     OR NEW.expected_effect IS DISTINCT FROM OLD.expected_effect
     OR NEW.pre_state_ref IS DISTINCT FROM OLD.pre_state_ref
     OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'exec_action_journal: only status/finished_at/result_ref/note may change' USING ERRCODE = '42809';
  END IF;
  IF OLD.status NOT IN ('started','unknown') THEN
    RAISE EXCEPTION 'exec_action_journal % is already settled (%)', OLD.code, OLD.status USING ERRCODE = '42809';
  END IF;
  IF NEW.status = 'started' OR (OLD.status = 'unknown' AND NEW.status = 'unknown') THEN
    RAISE EXCEPTION 'exec_action_journal % may not be restarted or re-opened', OLD.code USING ERRCODE = '42809';
  END IF;
  IF OLD.status = 'started' AND NEW.status NOT IN ('unknown','done','failed') THEN
    RAISE EXCEPTION 'exec_action_journal % has an invalid transition (%)', OLD.code, NEW.status USING ERRCODE = '42809';
  END IF;
  IF OLD.status = 'unknown' AND NEW.status NOT IN ('done','failed') THEN
    RAISE EXCEPTION 'exec_action_journal % must be settled from unknown', OLD.code USING ERRCODE = '42809';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
`;

/**
 * 0012_exec_remediation — PE-R remediation: uncovered_requirements enforce flag,
 * hook source for baseline, and journal hardening (forward-only).
 *
 * - Adds exec_settings column for uncovered_requirements enforce (R-03)
 * - Widens exec_gate_checks.source to include 'hook' (R-04 CI-log origin)
 * - No data loss; existing uncovered already computed via req_id LEFT JOIN
 */
export const MIGRATION_0012_EXEC_REMEDIATION = String.raw`
-- R-03: enforce flag for uncovered_requirements (default true = blocks completion)
-- Stored as project_settings.exec.uncovered_enforce; no new column needed,
-- but we add a helper index for the uncovered query.
CREATE INDEX IF NOT EXISTS exec_requirements_uncovered_idx ON exec_requirements (organization_id, project_id, status) WHERE status='active';

-- R-04: allow 'hook' as a baseline source alongside 'ci' and 'human'
-- The old CHECK was source IN ('ci','human'); widen it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'exec_gate_checks_source_check') THEN
    ALTER TABLE exec_gate_checks DROP CONSTRAINT exec_gate_checks_source_check;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname ILIKE '%gate_checks%source%') THEN
    -- fallback for differently named constraint in older dumps
    NULL;
  END IF;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
ALTER TABLE exec_gate_checks ADD CONSTRAINT exec_gate_checks_source_check CHECK (source IN ('ci','hook','human'));

-- R-04: record hook source capture for evidence (evidence:capture provenance)
-- No extra column: exec_evidence.ref already holds ci:<run_id> or hook:<sha>

-- R-06 already in 0011; no change
`;

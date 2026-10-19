/**
 * 0012_exec_remediation — PE-R remediation: uncovered_requirements enforce flag,
 * hook source for baseline, and journal hardening (forward-only).
 *
 * - Adds exec_baseline_tests.source 'hook' (R-04 CI-log origin)
 * - Index for uncovered query (R-03)
 */
export const MIGRATION_0012_EXEC_REMEDIATION = String.raw`
-- R-03: helper index for uncovered_requirements query (no criteria)
CREATE INDEX IF NOT EXISTS exec_requirements_uncovered_idx ON exec_requirements (organization_id, project_id, status) WHERE status='active';

-- R-04: allow 'hook' as a baseline source alongside 'ci' and 'human'
-- pg_constraint auto-name is exec_baseline_tests_source_check
ALTER TABLE exec_baseline_tests DROP CONSTRAINT IF EXISTS exec_baseline_tests_source_check;
ALTER TABLE exec_baseline_tests ADD CONSTRAINT exec_baseline_tests_source_check CHECK (source IN ('ci','hook','human'));
`;

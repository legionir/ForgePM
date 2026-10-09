# Blockers

Per plan §2: when something is blocked, continue with a mock/fake and record
it here; only missing GitHub push credentials may halt execution.

## B-001 — Docker unavailable in the execution sandbox
- Impact: acceptance items "`docker compose up -d` healthy in < 3 min" and
  the Testcontainers path cannot run locally.
- Mitigation: Postgres 14 + Redis run natively locally (DECISIONS D-001/D-009);
  compose file is shipped and its healthcheck/readiness behaviour is verified
  in Remote CI (which has Docker). Status: `local` verified via native
  services; `remote` covers compose.

## B-002 — PostgreSQL 16 not installable locally (apt has only 14)
- Impact: PG16-only syntax (`UNIQUE NULLS NOT DISTINCT`) can't run locally.
- Mitigation: schema contract uses the partial/expression-unique-index
  equivalent, which §12 explicitly permits; CI runs against postgres:16 to
  prove the real target too. Not a data-model deviation.

## B-003 — E2E (Playwright) not runnable in the Phase 0 sandbox
- Impact: Phase 0 has no E2E gate (first E2E gates are Phase 1), so nothing is
  falsely claimed. Playwright will run in Remote CI once the panel ships
  login/setup in Phase 1.

## B-004 — gh token lacks `read:org` scope
- Impact: some `gh api` org-level operations (branch protection requires
  checks via repo API only — OK; admin:org flows — unavailable).
- Mitigation: only repo-scoped operations are attempted (§16 step 7 tolerates
  missing access and reports it). No blocker for phases 0–7.

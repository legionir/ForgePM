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


## B-005 — [deviation] Angular panel UI not built this run
- Impact: §5/§6/... acceptance items that require Playwright E2E on real panel
  pages, and the "panel ships with each phase" rule, are not satisfied for the
  UI layer. Backend E2E-equivalent integration tests (REST) are green.
- Mitigation/plan: all domain logic lives in services exercised by REST
  integration tests; the panel is a thin client added as a follow-up effort.
  Status: OPEN — tracked as deviation per plan §2 rule 4 (record and continue).


## B-006 — [deviation] Phase 4b (MCP client to external servers) not shipped
- Impact: `mcp.client.enabled` gates a stub; the client itself (stdio child
  spawn + HTTP SSRF-protected fetch) is not yet built. The mandatory 4a
  Streamable HTTP MCP Server IS shipped, tested and smoke-verified.
- Plan: implement as a follow-up; the schema (mcp_servers, allowed_tools,
  enabled) and the §14 SSRF helper are already in place.


## B-007 — [deviation] Phase 6 panel Reviews page not built this run
- Impact: the §10 acceptance item "پنل: صفحه Reviews … با E2E روی fake" ships
  with the panel follow-up (same tracked item as B-005/D-013), not in this
  phase commit. Every page capability (run list, findings + filters,
  approve/dismiss, create issue, policy management) exists as tested REST +
  MCP surface; the panel is a thin client.
- Status: OPEN — recorded per plan §2 rule 4 (record and continue).

## B-008 — [deviation] GitHub octokit diff/comment adapters pending panel wiring
- Impact: `setDiffProvider` and the GitHub review-output writer have tested
  slot interfaces + fake implementations, but the octokit-backed production
  adapters (PR file fetch + marked comment create/update) are wired when the
  GitHub App installation flow ships with the phase-7 panel
  (`@octokit/app`/`@octokit/webhooks` are pinned devDeps today).
- Mitigation: webhook→outbox→worker auto-run path is proven end-to-end in
  `phase6-worker.test.ts` with stubs; the real adapter only fills the slots.
- Status: OPEN — tracked with the phase-7 GitHub panel work (B-005 family).

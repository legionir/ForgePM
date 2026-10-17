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

## B-005 — [CLOSED] Angular panel: all §11 pages shipped
- Original: the deferred panel (D-013); Phase 7's first increment shipped only
  Setup/Login, Projects and API Keys + the flagship subset E2E.
- Closed by the panel-completion increment: the remaining §11 pages (Work
  Items List+Board with server-side transitions, item detail, Features/
  Milestones, Planner with the fake provider, Approvals, Reviews, GitHub,
  MCP log, full Settings inheritance matrix, System health/jobs/backup,
  Users+Audit, AI Providers) ship as thin clients over the tested REST
  surface; the full 9-step §11 E2E chain, i18n key-parity
  (`apps/web/scripts/i18n-check.mjs`), the axe sweep (no serious/critical
  violations), fa/RTL and 360/1280 no-overflow checks all run green locally
  (`bash apps/web/e2e.sh`), and P-05 measures first paint of the 200k-item
  list at 217 ms via `bash apps/web/e2e-perf.sh`. CI runs the same gates.
- Remaining nuance: Playwright still drives the API directly rather than
  through compose (Docker unavailable in this sandbox — B-001); CI is the
  compose/Docker surface. Not a panel scope item.
- Status: CLOSED.

## B-003 — [superseded] E2E now runs locally via a real Angular dev-server + native API
- Original: Phase 0 had no runnable Playwright gate. Superseded in Phase 7:
  `apps/web/e2e.sh` boots the real Fastify API (throwaway DB) + the dev-server
  and drives Chromium — the flagship E2E passes locally (see B-005 for scope).

## B-004 — gh token lacks `read:org` scope
- Impact: some `gh api` org-level operations (branch protection requires
  checks via repo API only — OK; admin:org flows — unavailable).
- Mitigation: only repo-scoped operations are attempted (§16 step 7 tolerates
  missing access and reports it). No blocker for phases 0–7.


## B-006 — [deviation] Phase 4b (MCP client to external servers) not shipped
- Impact: `mcp.client.enabled` gates a stub; the client itself (stdio child
  spawn + HTTP SSRF-protected fetch) is not yet built. The mandatory 4a
  Streamable HTTP MCP Server IS shipped, tested and smoke-verified.
- Plan: implement as a follow-up; the schema (mcp_servers, allowed_tools,
  enabled) and the §14 SSRF helper are already in place.


## B-007 — [CLOSED] Phase 6 panel Reviews page shipped with the panel
- Original: the §10 "پنل: صفحه Reviews … با E2E روی fake" was deferred with the
  panel (same family as B-005/D-013). It now ships: runs/findings lists with
  filters, dismiss/accept/create-issue actions, and guidance-only rendering
  while the modules are off — with the fake-provider code review proven end to
  end inside the §11 flagship chain spec (`e2e/chain.spec.ts` step 9).
- Status: CLOSED (was OPEN, tracked with the phase-7 panel work).

## B-008 — [deviation] GitHub octokit diff/comment adapters pending panel wiring
- Impact: `setDiffProvider` and the GitHub review-output writer have tested
  slot interfaces + fake implementations, but the octokit-backed production
  adapters (PR file fetch + marked comment create/update) are wired when the
  GitHub App installation flow ships with the phase-7 panel
  (`@octokit/app`/`@octokit/webhooks` are pinned devDeps today).
- Mitigation: webhook→outbox→worker auto-run path is proven end-to-end in
  `phase6-worker.test.ts` with stubs; the real adapter only fills the slots.
- Status: OPEN — tracked with the phase-7 GitHub panel work (B-005 family).

## B-009 — [environment] Execution-control (PE-0) DB-dependent gates not run locally
- Impact: `npm run migrate`, `npm run schema:check` against a live schema and
  `npm run test:integration` (including the new
  `tests/integration/exec-ledger-invariants.test.ts`: append-only triggers,
  20-way concurrent code allocation, module-off behaviour) were NOT executed in
  the sandbox where PE-0 was written — no Postgres, no Redis, no Docker, and
  `apt-get` has no network. They are written, committed and green-by-construction
  against the same SQL the migration ships (offline column/index parity check),
  but they have not been executed against a real database yet.
- Mitigation: the unit suites (215 tests incl. 99 exec tests) + lint + typecheck +
  build all pass locally; the integration file is deterministic and isolated per
  file via the standard harness. Run `npm run test:integration && npm run
  schema:check` on any host with the CI service containers before closing PE-0.
- Status: OPEN — this is OI-8/OI-9 of `docs/EXECUTION_CONTROL_PLAN.md` §18
  (accept `not-run` in CI without docker, or provide a runner); no gate result is
  claimed for those two items.

# Progress log

Per plan §2 rule 5. After every phase we record status, last commit, remaining
gates and the next step so a resumed run knows exactly where to pick up.

## Phase 0 — v0.0.0
Status: **complete** (local pass, remote pass). See `PHASE0_REPORT.md`.

## Phase 1 — v0.1.0
Status: **complete** (local pass, remote pass — CI run 37874572807). Panel UI deferred (B-005).

## Phase 2 — v0.2.0
Status: **complete** (local pass, remote pass — CI run 37877395571; tag v0.2.0 = HEAD 890b743). Panel + Playwright E2E deferred (B-005).

## Phase 3 — v0.3.0
Status: **complete** (local pass, remote pass — CI run 37879871008; tag v0.3.0 = HEAD 40933f3). Panel deferred (B-005).

## Phase 4 — v0.4.0 (server side)
Status: **complete** — 4a shipped: Streamable-HTTP `/mcp`, real-SDK-client
integration test, `npm run mcp:smoke` green against a running server.
4b (optional MCP client) deferred with B-006. Panel MCP settings deferred
with the rest of the panel (B-005).

## Phase 5 — v0.5.0
Status: **in progress** — backend complete (webhook+HMAC, PR/issue/release
processing shared by api+worker via core, module lifecycle, 5 MCP tools,
secrets at rest); 14 phase-5 tests + unit tests green; full verify green
(173 tests). Reconciliation daily job + panel page deferred to Phase 7 (B-005).

## Phase 6 — v0.6.0
Status: **complete** (local pass, remote pass — CI run 37907130578; tag v0.6.0 = HEAD 5bf5225) — shared review
engine + Code Review + Refactor Review in core; REST + 8 MCP tools + worker
webhook auto-run; settings registry incl. 422 redeclaration rule; migration
`0008_reviews` matches Schema Contract §G (43 tables verified). 54 new tests;
suite 227 green; `npm run verify` green; CI-equivalent gates (fresh-DB migrate,
schema:check + selftest, docs:check, migration-hash guard, phase-report
selftest) all re-run green. Panel Reviews page + octokit diff/comment writers
deferred with the panel (B-007/B-008, same family as B-005).

## Phase 7 — v0.7.0
Status: **complete** (local pass). The panel-completion increment closed every
open §11 gate B-005 tracked:

- System REST surface (jobs/retry/health/backup + mcp/calls) — 7 red-first
  integration tests green; contract-promised endpoints now exist.
- All remaining §11 pages shipped as thin REST clients (Work Items List+Board,
  item detail, Features/Milestones, Planner w/ fake provider, Approvals,
  Reviews, AI Providers, GitHub, MCP log, full Settings inheritance, System
  health/jobs/backup, Users+Audit).
- i18n fa/en + RTL with `i18n-check.mjs` parity gate (120 keys); axe sweep no
  serious/critical; 360/1280 no-overflow checks — all in the §11 chain spec.
- `npm run seed:perf` + `npm run perf` (P-01..P-03) + P-05 Playwright first-paint
  gate (`e2e-perf.sh`) all green; `0009_perf` cursor indexes fixed the P-02
  ~6s scan the load run exposed (now ~70ms).

Gates (local): `npm run verify` 39 files / 269 tests green; `gen:api:check` green;
`schema:check` green (43 contract tables; 0009 adds indexes, no new table); `docs:check` green;
migration-hash guard green; `bash apps/web/e2e.sh` (flagship + full §11 chain +
a11y/RTL/overflow) green; `bash apps/web/e2e-perf.sh` (P-05, 217ms) green;
`npm run perf` (P-01..P-03) green.

Squash-merged to `main` as one commit (plan §2 step 5). Remote CI runs on the
push; tag `v0.7.0` is applied only after that run is green (never before).

Last commit: `main` HEAD (squash of phase/7-panel-completion).
Next step: §16 — verify on a clean clone, bump to `1.0.0-rc.1`, push `main` +
all tags (`v0.0.0`..`v0.7.0`, `v1.0.0-rc.1`), watch Remote CI on the pushed
sha, then write and push `docs/FINAL_REPORT.md`.

## Final phase — §16 (v1.0.0-rc.1) — DONE
Status: **delivered** (local pass, remote pass — CI run 38022178098 on
`7711811`). gitleaks clean (history allowlisted one documented placeholder,
D-037), Local Verification green, clean-clone install green (compose path runs
in CI per B-001), publish.sh idempotent (two passes), branch protection not
applied (token scope, recorded). `docs/FINAL_REPORT.md` written and pushed.
Tags `v0.0.0`..`v0.7.0` + `v1.0.0-rc.1` present on origin. Stop condition
reached (plan §2 "اجرای بی‌توقف" item 3a).

---

## Execution control (docs/EXECUTION_CONTROL_PLAN.md)

### PE-0 — module scaffold, migration, settings, codes
Status: **code complete, partially verified locally**.

- Done: `0010_exec` (17 tables + triggers + REVOKE + `work_items.exec_task_id`),
  DATA_MODEL §H contract block (column/index parity checked offline), shared
  exec schemas, `packages/core/src/exec/*` (gate, policy, open items, evidence,
  scope, baseline, journal, session, review input, codes, events), 21 `exec.*`
  settings, `exec` module registration (off by default), `ledger:*` scopes,
  99 unit tests, integration test file, docs (DECISIONS D-039/D-040, BLOCKERS
  B-009, CHANGELOG, plan PE-0 checkbox results).
- `local:` `lint` ✅ · `typecheck` (all workspaces) ✅ · `test:unit` ✅ 215/215 ·
  `build` ✅ · `docs:check` ✅ · `check-migration-hashes` ✅ (manifest updated).
- `local not-run:` `migrate` / `schema:check` / `test:integration` / coverage —
  no Postgres, Redis or Docker in this sandbox (B-009 = plan OI-8/OI-9).
- `remote:` not-configured (branch `arena/c216c536-forgepm`, no CI run yet).
- Next: PE-1/PE-2 (ledger services + the first 4 tools: `exec_task_start`,
  `exec_ledger_status`, `ledger_list_open`, `ledger_add_open_item`,
  `ledger_resolve_item`) on top of `exec_events` + `validateResolution`.

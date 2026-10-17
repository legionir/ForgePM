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
Status: **code complete — local gates green, hosted CI green except the
(inherited, now fixed) panel E2E step; PE-0 stays open until the job is fully green**.

- Done: `0010_exec` (17 tables + triggers + REVOKE + `work_items.exec_task_id`),
  DATA_MODEL §H contract block (column/index parity checked offline), shared
  exec schemas, `packages/core/src/exec/*` (gate, policy, open items, evidence,
  scope, baseline, journal, session, review input, codes, events), 16 `exec.*`
  settings (the five `exec.runner*` keys were struck with D-041), `exec` module registration (off by default), `ledger:*` scopes,
  101 exec unit tests + a 4-test structural guard (no spawn path, D-041), docs
  (DECISIONS D-039…D-043, BLOCKERS B-009/B-010, CHANGELOG, plan PE-0 results).
- `local:` `lint` ✅ · `typecheck` (all workspaces) ✅ · `test:unit` ✅ 221/221 ·
  `build` ✅ · `docs:check` ✅ · `check-migration-hashes` ✅ (manifest updated).
- `local (real DB, no Docker):` `migrate` on an empty PostgreSQL ✅ + idempotent
  rerun ✅ · `schema:check` ✅ ("60 contract tables verified") ·
  `tests/integration/exec-ledger-invariants.test.ts` ✅ 13/13 · full
  `test:integration` with `FORGEPM_TEST_NO_REDIS=1` → 183/190 (the 7 failures
  are environment-only: `outbox`/`phase5-worker` need Redis,
  `phase7-backup`/`phase7-system` need `pg_dump`; none touches exec) ·
  migration manifest ✅ 9 hashes. DB came from the repo's own embedded
  Postgres path (D-042); the three exec bugs this run exposed are fixed in the
  same commit.
- `local not-run:` the queue-based suites (no Redis in this sandbox; they run in
  CI). Coverage is **no longer** not-run: hosted CI executed `npm run verify`
  with the coverage thresholds and it is green.
- Plan OI‑8/OI‑9 are closed: the Docker-bound test was cancelled together with the
  runner path (D-041), so nothing is skipped "because there is no Docker".
- `remote:` **running again** (billing fixed) — on PR #9: `Install`,
  `Migration hash guard`, `Migrations on an empty DB`, `npm run verify`
  (lint+typecheck+unit+integration+**coverage thresholds**+build) and
  `gen:api drift check` are ✅ on hosted CI. The remaining red step was
  `Panel build + Playwright flagship E2E`, which is red on `main` too (proven with
  the zero-change probe PR #10): `e2e-reset.mjs` hardcoded the author's absolute
  workspace path, so `pg` could not be resolved off that machine (B-010, D-043).
  With that fixed the step exposed two more `main`-side failures: the badge/chip tint
  contrast (fixed here, CI-confirmed gone — D-044) and the board drag. The drag was
  first misattributed twice (payload, then "headless never starts a drag"); an
  instrumented local run found the real cause — a scroll race in the spec's own
  `dragTo` — and PE-0.9 below fixed both sides (D-046, B-011). Net `remote:` at
  `dc3efb8` was every step green **except** that inherited E2E step, so PE-0 stayed
  open until PE-0.9.
- `remote:` evidence: run 39072159787 (both candidate fixes) — every step green except
  the panel E2E; probe run 39072516664 with the temporary log-annotation tail —
  `chain.spec.ts` went from 2 failures to 1, i.e. the axe `color-contrast` violation is
  gone and only the drag assertion (`:66`) remains, tracked as #11; final run
  39073122374 — `verify` green (lint, typecheck, unit+integration+coverage, build,
  migrations, hash guard, `gen:api` drift) with the same single red step.
  An earlier revision of this entry claimed Playwright could not run at all here ("no
  chromium download") — **false**, and it cost three CI round-trips built on guesses.
  The sandbox can drive the repo's own `@sparticuz/chromium` against an embedded
  Postgres (recipe in docs/FRONTEND_EXECUTION_PLAN.md, "Local E2E recipe"), which is
  how the drag failure was measured rather than theorised. Hosted CI remains the
  acceptance arbiter (D-041): local runs diagnose, the remote run closes a gate.

## PE-0.9 — board drag made engine-independent (issue #11, D-046)

- Scope (owner-approved "continue" after the three-way options were laid out): clear the
  last inherited §11 E2E failure without weakening it.
- `chain.spec.ts`: `targetPosition` pins the release inside the target column's top area,
  and the spec now asserts the card under the pointer still carries the key it read — the
  race became visible instead of being papered over; the state-change assertion is unchanged.
- `apps/web/src/app/ui/board-drag.ts` + the pure reducer in `ui/logic.ts`: pointer session
  (4px threshold, foreign-column check, per-press token so one gesture applies once),
  HTML5 DnD kept as the browser path, touch untouched, `dragstart` hands over cleanly.
- Gates added for real: `npx ng test --configuration=coverage` now runs inside the CI panel
  step, so the panel's unit tests + ≥80% coverage thresholds are enforced remotely.
- `local:` `test:web` **77/77** (14 new drag tests: 6 reducer + 8 DOM) · coverage of the
  new code 95% stmts / 98% branches (board-drag), 100% / 94% (logic) · lint ✅ ·
  typecheck 0 ✅ · `ng build` ✅ · contrast 52 pairs ✅ · raw-value ✅ · docs:check ✅ ·
  **real-browser E2E: `chain.spec.ts` 1/1 green in 4.4s** (both drag paths exercised:
  native `dragstart→drop`, and pointer-only with `draggable=false`), plus the flagship
  spec ✅ and the fa/RTL+axe spec ✅ (run separately; `--single-process` allows one per
  launch). `remote:` pending on this branch.
- Next: PE-1/PE-2 (ledger services + the first 4 tools: `exec_task_start`,
  `exec_ledger_status`, `ledger_list_open`, `ledger_add_open_item`,
  `ledger_resolve_item`) on top of `exec_events` + `validateResolution`.

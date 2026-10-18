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
- **PE-0 CLOSED 2026-10-18** — `remote: pass` on run 39076763818 (`2edeeb9`): all 22
  steps green, including `Panel build (Angular) + Playwright flagship E2E` and the new
  `ng test --configuration=coverage` inside it. PE-0.9 (board drag, issue #11) was the
  last inherited failure; it is fixed on both sides (D-046) and `chain.spec.ts` also
  passes locally against a real chromium. The ledger-side ritual for this phase
  (`ledger enable exec_control` + `req_add`/`record_decision`/`approve` + `task_split`)
  is PE-1's first work item, since the ledger tools only exist from PE-1/PE-2 on.
- Next: PE-1/PE-2 (ledger services + the first 4 tools: `exec_task_start`,
  `exec_ledger_status`, `ledger_list_open`, `ledger_add_open_item`,
  `ledger_resolve_item`) on top of `exec_events` + `validateResolution`.

## PE-1 — open-item ledger: the only write path, the shared status projection (A.2–A.8 closed)

- Scope: §6 PE-1 as far as PE-1 can be closed on its own — laws, DB and service. The tool-facing
  halves of A.1/A.3 and the panel-side A.9 are explicitly deferred with reasons (D-047), not ticked.
- `packages/core/src/exec/open-items-service.ts`: `parseOpenItemCreate` / `parseOpenItemResolve`
  (`safeParse` → structured `VALIDATION_ERROR` + `needed_action`, never a throw = A.5),
  `findTaskByRef` by id **or** `T-NNN` code, `createOpenItem` (shared `BLOCKING_BY_DEFAULT`,
  C.4 dedup pre-check → `CONFLICT` naming the existing code, `allocateLedgerCode(…, 'OI')`, one
  `open_item.created` event with `before: null`), `resolveOpenItem` (soft closure by an agent on a
  blocking item refused **before** any write → `LEDGER_TRANSITION_NOT_ALLOWED` = A.3, then
  `open_item.closed|reopened` with `payload.before/after` = A.4), `listTaskItems` (active first).
  Unknown `task_ref` → `NOT_FOUND`, zero rows written = A.8. Callers own the transaction and must
  write `audit_event` themselves (PE-2 wires that).
- `packages/core/src/exec/ledger-view.ts`: `buildLedgerStatus` — pure "what blocks submission"
  (blockers, criteria without passing evidence, unanswered blocking questions, required decisions,
  unmet `verify_criterion` exits), sorted by code so the output is reproducible; PE-2's tool and
  PE-12's panel must both consume it instead of re-deciding. One integration test builds the view
  from real rows to prove the shapes match.
- `tests/unit/exec-no-delete.test.ts` (A.2 as a gate): three forbidden shapes (`DELETE FROM exec_*`,
  write-through UPDATE of `exec_events`/`exec_evidence`/`exec_gate_checks`, any route path
  containing `/exec`) + a positive control proving the patterns bite + "one `appendEvent(db,` per
  gesture, only `INSERT INTO/UPDATE exec_open_items`". No new migration was needed (0010 already had
  the CHECKs); a unique dedup index was deliberately **not** added because C.4 wants skip-not-reject.
- `local:` unit **268/268** · exec unit **142/142** · `--project integration` on real Postgres:
  **21/21** for `exec-ledger-invariants` (13 PE-0 + 8 PE-1) and 189 passed / 5 failed / 2 skipped for
  the whole suite — all five failures `pg_dump`/Redis-bound (B-005, `FORGEPM_TEST_NO_REDIS=1`) ·
  lint ✅ · typecheck 0 ✅ · build ✅ · docs:check ✅.
  Panel component gates (`test:web`, `contrast:check`, `raw-value:check`, `ng build`): `not-run` —
  no panel component file is in this change (they were green at `2edeeb9`); the scripted E2E gate
  that does cover the panel was run anyway, next bullet.
- `local (tooling):` the phase became runnable by fixing the machine-dependencies it hit: the
  integration harness and `e2e.sh` both shelled out to `psql`, which `@embedded-postgres` does not
  ship, so DDL now goes through `pg` (`scripts/e2e-db.mjs`, `DROP … WITH (FORCE)` + retry) and
  `dev-postgres.mjs` re-uses an existing cluster (D-048). Consequence: **the scripted panel E2E gate
  completed here for the first time** — `bash apps/web/e2e.sh` green, chain 3.5s, fa/RTL+axe 5.3s,
  flagship 1.2s, `visual.spec`'s 14 opt-in skips (`VISUAL=1`) untouched.
- Lesson kept from this phase: one red assertion was _my test_, not the projection — `open_item_codes`
  lists active items only, and a resolved item staying in `all` while leaving `open_item_codes` is
  exactly what "history, not cleanup" (A.2) means. The projection stayed; the expectation moved.
- `remote:` **pass** on the PR head `236af36` (run 39082268502, 22/22 steps) and on the substantive
  head `5915afc` (run 39081071740, 22/22 steps): verify with real Redis, panel build + flagship E2E,
  perf, schema:check, docs:check, docker-compose smoke, npm audit. The head `d859c37`/`61ca4a7`
  (docs-only and ci.yml-only) were red at step 10 — same code as a green run, cause unreadable at the
  time. That intermittency is B‑013, opened on purpose instead of smoothed over: `remote: pass` here
  means "a full green run exists for this code", and two consecutive reds on one sha must be treated
  as a defect. panel build + flagship E2E, perf, schema:check, docs:check, docker-compose smoke, npm audit).
  History, kept because it is the interesting part: the first run on this PR (39080689060) was
  **red at the panel E2E step after 52 s** and unreadable from here (B-012: raw logs redirect to a
  blob host outside the allowlist, so the annotation only said "exit code 1"). Instead of guessing
  among three plausible causes, the step was instrumented to emit its own failure tails as an
  annotation; the next run — same substantive diff — is green, so the single red is recorded as
  **cause unknown, not reproduced** (B-012), not as a bug that was fixed.
- Next: PE-2 (section B core) — `exec_task_start`, `ledger_list_open`, `ledger_status`,
  `ledger_add_open_item`, `ledger_resolve_item` as thin wrappers over these service functions, the
  `unitOfWork` + `audit_event` pairing, the tool-shaped re-assertions of A.1/A.3, then the §7 B.x
  gates (idempotency, scope, policy refusals).

## PE-2 — the five ledger tools over the real dispatch path (B.1–B.8 closed)

- Scope: `exec_task_start`, `ledger_add_open_item`, `ledger_resolve_item`, `ledger_list_open`,
  `exec_ledger_status` — registered, `module: 'exec'` gated, and each a thin wrapper over PE-1's
  service so no rule has two owners. §6 A.1 closed here too (the tool + the empty-project answer).
- `packages/core/src/exec/task-start.ts`: `parseTaskStart` (shape) and `checkCriteria` (the law,
  mapping `assessCheckable` onto `CRITERION_NOT_CHECKABLE` and reporting **every** bad criterion in
  one answer), `createTask` (T-code via `allocateLedgerCode`, the `exec_tasks` row, one `exec_criteria`
  row per criterion with C-codes, unknown `req_ids` → `NOT_FOUND`, one `task.created` event).
- `packages/core/src/exec/ledger-status.ts`: `loadLedgerStatus` — six queries for the whole task set,
  feeding `buildLedgerStatus`; `{empty:true, needed_action}` when the project has no task (B.5),
  `NOT_FOUND` for an unknown `task_ref` rather than a misleading empty answer (A.8).
- `apps/api/src/modules/exec/service.ts` + `mcp-tools.ts`: project resolution (explicit `project_ref`
  → the key's single bound project → refusal naming both), the agent path inheriting
  `work_item.create`'s approval gate with **checkability evaluated first** (so an unexecutable
  payload never spends an approval slot), `recordAudit` inside the same `unitOfWork`, idempotency via
  `beginIdempotency`/`storeIdempotencyResult`/`abandonIdempotency`, and `FORBIDDEN_SCOPE`/
  `mcp_tool_calls` masking left to dispatch where they already lived. `gateAgentOperation` is now
  exported rather than re-implemented (D-049).
- `apps/api/src/modules/mcp/json-schema.ts`: `tools/list` advertises the enforced shape — real types
  and bounds, and `additionalProperties: false` exactly when the schema is a `strictObject`. The old
  mapper told every client that extra keys were welcome while the handler refused them (B.1).
- Tests: 18 unit on the task-start parser/laws (incl. the 10-row checkable/vague table with a Persian
  row) · 11 unit on the advertisement (per tool, plus "every advertised type is valid JSON Schema") ·
  12 integration through `callTool`: one-shot task creation with its event + audit row, the
  `pending_approval` path writing nothing, masking of `api_key` in a refused call, read-only scope,
  idempotent replay, and A.3 at the tool boundary (refusal leaves the event count alone; the human
  closes it; `ledger_list_open` still shows it as history — A.2). The 12th case is D-049 #2: a task
  that declares `req_ids` gets the echo and **not** the coverage, and the requirement stays in
  `requirements_uncovered` (seeded in its own project, because that list is read project-wide).
- PE-0's registry expectation was updated, not weakened: it used to assert that no `exec_*` tool
  exists at all; now it asserts the exact five, that all five are `module: 'exec'`, and that no tool
  name looks like a ledger delete path. "Dark" now means gated, which is the real invariant.
- Two bugs the gates caught (both mine, both real): comparing a `text` ref against a `uuid` column
  surfaced as `INTERNAL` instead of `NOT_FOUND` on three call paths, and the `default(...)` fields
  were advertised as required. Fixed with tests attached to each.
- `local:` unit **297/297** · `--project unit packages/core/src/exec apps/api/test/unit` 142+29 ✅ ·
  integration on PostgreSQL 18: `exec-tools` **12/12** + `exec-ledger-invariants` **21/21** (33/33) ✅,
  whole suite 202 passed / 5 failed / 2 skipped — the same five Redis/`pg_dump`-bound files
  (B-005/B-009) · lint 0 ✅ · typecheck 0 ✅ · build ✅ · docs:check ✅ · `gen:api:check` ✅ (no REST
  route was added, so the committed spec and client are still the truth). Panel component gates: see
  the next line — the tools touch no panel file.
- `local (panel):` `bash apps/web/e2e.sh` **exit 0** — `chain.spec.ts` 2/2 (the §11 full chain with the
  board drag; then fa/RTL + axe, no serious/critical violation on `/projects`, `/work-items`,
  `/features`, `/planner`, `/api-keys`, `/system`) and `flagship.spec.ts` 1/1; `visual.spec.ts` = 14
  opt-in skips, which is the documented default. A `VISUAL=1` probe in the reinstalled container came
  out 9/14: the five diffs are _height_ differences (1280×569 vs 1280×503 …) because the per-file
  `e2e-reset` truncates to an empty install while the committed baselines were captured on a populated
  one — D-046's standing judgment that baselines are a human concern, and not a PE-2 regression.
  Getting the suite to launch at all took the harness fix in `apps/web/e2e.sh` (see the changelog):
  `--single-process --no-zygote` survived one launch only, and ANGLE/SwANGLE cannot init without a GPU.
- `local (B.3 at the CLI):` the plan's CLI-level under-40-character case is **not** a PE-2 gap:
  `scripts/ledger-cli.ts` (D-11) does not exist yet and is PE-3's work item; the floor itself is
  enforced and tested where it lives — `openItemInputSchema.why_not_blocking.min(40)` and the
  `ledger_add_open_item` tool.

- `local (coverage):` the CI gate is `vitest run --coverage` over **both** projects, which cannot be
  measured here while the Redis-bound files fail (vitest suppresses the report on failure). The two
  slices instead: unit-only `task-start.ts` 38.8% / `json-schema.ts` 96.6%, integration-only
  `task-start.ts` 86.4%, `ledger-status.ts` 84.6%, `apps/api/src/modules/exec` 82.9% — every new file
  clears 80% lines on the union, so the risk is in branch details, not in an untested surface.
- `remote:` **cannot-run — this session's branch is closed to GitHub** (PR #12 was merged, so pushes
  and new PRs from `arena/c216c536-forgepm` are refused). PE-2 is committed locally on this branch and
  must be pushed from a fresh session; CI has not seen it. Not a waiver: `npm run verify`'s integration
  half here runs without Redis, which CI does have, so the remote gate still owes a verdict.
- Recorded on `arena/c216c536-forgepm` as `caa59db` — 79 files, the re-materialised PE-0 + PE-1 +
  PE-2 tree (the sandbox was reset twice and rewound git to `bc6f28b`, deleting the earlier local
  commit). The sha is written down here precisely because a reset can take it out of git again.
  `docs/PHASENaN_REPORT.md` was deliberately left untracked: it is a stale `report:phase` artifact
  titled "Phase NaN" with a `local: fail` verdict that belongs to no phase, and committing it would
  pass off a leftover as evidence.
- A fresh session starts at `docs/HANDOFF-PE-3.md`: where the work lives (only 2 local commits are
  ahead of GitHub), what to restore first, the PE-3 step list, and the traps that cost time here.
- Next: PE-3 (plan §8) — `exec_submit_exit_report` with the strict `exitReportSchema` and the
  explicit-"none" rule, `exec_task_complete` as the single gate over the 13 rules that PE-0 already
  shipped in `packages/core/src/exec/gate.ts`, the Gate stamp into `exec_gate_checks`, `deriveStatus`,
  `buildFinalReport`, and the WorkItem linkage (§8.3 / I-1) — plus acceptance C.1–C.11 and C.9b. Two
  sequencing corrections to the plan-following notes, both checked against the plan rather than
  guessed: `ledger_add_evidence`, `ledger_record_decision` and `ledger_ask_human` are **PE-4** (§9, table
  row `ledger_ask_human … PE-4`), so PE-3 only _reads_ `exec_evidence` — for rule 3 and for the
  `tests_executed[].evidence_id` references; and there is **no** `ledger_answer_human` tool anywhere
  in the plan — answering a blocking question is the human path (`ledger:decide` scope over
  REST/panel/CLI), because an agent must not be able to answer its own question. The CLI
  (`scripts/ledger-cli.ts`, D-11) is PE-4's deliverable too, so the CLI-level floor for a short
  `why_not_blocking` belongs there; it must reuse the core services instead of speaking the tools'
  HTTP shapes.
- Two debts PE-3 inherits that are worth naming before anyone starts: `packages/core/src/exec/gate.ts`
  is **590 lines**, which already violates the plan's own C.11 bound (`gate.ts` ≤ 400 lines, each rule
  ≤ 60) — split it into per-rule modules _before_ adding wiring, keeping `rule01…rule13` numbering and
  order frozen; and the plan's §19 bootstrap (steps 2–9: one REQ per §, `record_decision` for D-01…D-13,
  `task_split` for PE-0…PE-12, `fact_record` + `baseline_capture`) has never run, because the CLI it is
  written against does not exist yet — so PE-0…PE-2 are recorded in git and in these docs, not in
  `exec_*` rows. Back-filling those rows is legitimate PE-4+ work, not something to fake now.

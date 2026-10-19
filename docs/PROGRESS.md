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
- `remote:` **pass** — PR #13 (`arena/e737b1f8-forgepm`, the fresh session the PE-2 handoff asked
  for), run 39120040693: all 22 steps green, including the full `npm run verify` with its coverage
  thresholds, the gen:api drift check, the Angular build + Playwright flagship E2E, the performance
  budget and the docker-compose health smoke. The earlier `cannot-run` verdict — this session's
  branch was closed to GitHub, so CI had never seen the tree — is superseded: CI has seen it now, and
  it saw the integration half with Redis, which the local half could not run.
- Recorded on `arena/c216c536-forgepm` as `caa59db` — 79 files, the re-materialised PE-0 + PE-1 +
  PE-2 tree (the sandbox was reset twice and rewound git to `bc6f28b`, deleting the earlier local
  commit). The sha is written down here precisely because a reset can take it out of git again.
  That tree is now on GitHub as PR #13 (`arena/e737b1f8-forgepm`), so the work is no longer only
  local. `docs/PHASENaN_REPORT.md` was deliberately left untracked: it is a stale `report:phase`
  artifact titled "Phase NaN" with a `local: fail` verdict that belongs to no phase, and committing
  it would pass off a leftover as evidence.
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

## PE-4 — the tools that make the human part of the loop real (B.9–B.11)

**Started.** Three slices so far, in the plan's own order:

- **§9.1 `ledger_add_evidence`** — the write path that makes "a claim without
  proof is forbidden" true: the ref is READ before anything is written, secrets
  are masked on the way in (B.16), and the evidence, the criterion it verifies
  and the event commit together.
- **§9.2 `ledger_record_decision`** — the risk level is COMPUTED from the
  policy table, never sent by the agent (B.9's I‑4). An approval-level decision
  is stored `pending` with `do_not_apply_until_human_approval:true`; a denied
  one is not recorded at all (0010's `risk_level` CHECK has no room for it).
- **§9.3 `ledger_ask_human`** — a question with the impact of EACH option
  (B.11). A blocking question parks the task in `awaiting_review` and writes
  the unblock condition the ledger's CHECK demands. There is no timeout:
  silence is not approval.

All three are the tools the gate's rules 3, 4, 5 and 11 point at — before
this slice, an agent that hit those rules was told to call a tool that did not
exist.

- **§9.5 the human path** — four REST routes under `/api/v1/exec/*`
  (`GET /exec/status`, `POST /exec/items/:code/resolve`,
  `POST /exec/questions/:code/answer`, `POST /exec/approvals/:id/decide`).
  The important one is the last: until now, a human approving an
  `exec.decision` in the generic approval queue left the DECISION pending,
  so the gate kept refusing with nothing left to fix. The approval and the
  ledger now move together (the same transaction, `decision.approved` in the
  event stream). The mutating routes need the human-only `ledger:decide`
  scope; an agent's key gets `FORBIDDEN_SCOPE` (B.15's REST half ✓ — the CLI
  itself is still to come).
- **§9.4 `exec_policy_check`** — "what would the policy say about this?",
  answered by the same table that decides, so the answer cannot be a guess.

- **`scripts/ledger-cli.ts`** (D‑11) — the human's command line: `list`, `show <T>`,
  `resolve <OI> --status --note`, `answer <Q> "…"`, `approve/reject <D>`. It speaks to the
  same `/api/v1/exec/*` routes the panel uses and never connects to the database — a tool
  that can reach the DB can do what the human's key may not. The output is one page (40
  lines) unless `--json` is passed.

- **The rest of the human path (D‑058, D‑059)** — the verbs the plan's tool
  table (§4.0) gives to nobody but a human: **waive** a criterion, **drop** a
  requirement, **widen** a task's scope, **promote** a guess into a fact, and
  ask the gate "may this close?" **without closing anything**
  (`POST /exec/gate/:taskId` writes no stamp, no report status and no event).
  Two of them are forced by the schema itself: a waived criterion points at
  the approval that waived it (`waiver_approval_id` is NOT NULL) and a dropped
  requirement carries `dropped_by` + a reason. The other two now write a
  decided approval row too, so all six kinds are one list the panel can read
  with the ledger's own codes (`GET /exec/approvals`).
- **A crash found by reading the code (D‑058)** — the gate's snapshot loader
  read `exec_req_tasks`, a table **no migration ever created** (D‑049 #2 had
  already dropped the requirement↔task table in favour of the criterion's own
  `req_id`). Every gate run would have failed on a missing relation, and the
  phantom table was also in the DB interface. The link now comes from the
  criteria; the table is gone from the code and from the types.
- **The CLI grew the rest of the human's verbs** — `waive <C>`, `req drop
<REQ>`, `approve-scope <T>`, `fact promote <F>`, `policy print|set`, and
  `show <T>` now prints the gate's verdict (the dry run) under the ledger
  view.

The OpenAPI spec and the typed client were regenerated (`npm run gen:api` ✓,
92 paths) and the panel's API-key form now offers `ledger:decide`.

\*\*The first slice of PE‑4 (§9.1) is the one the gate's rule 3 points
at: without it an agent cannot attach proof, so a task whose criterion has no
evidence could never close.

- **`ledger_add_evidence`** (the eighth ledger tool) — the ref is READ before
  anything is written: a path that is not there is `EVIDENCE_INVALID` (D‑057 —
  the plan says so twice, and it means "you pointed at the wrong place", not
  "come back later"), a file outside `exec.allowed_repo_roots` is a
  `SCOPE_VIOLATION`, a test log with no result line is a paraphrase, and a
  path that exists but cannot be read is `EVIDENCE_UNAVAILABLE`.
- **Secrets are masked on the way in** (B.16): the ref, the summary and the
  payload all go through `redactSecrets` before a byte is written, and the
  number of hits is recorded in the row's meta and in the answer.
- **One transaction**: the evidence row, the criterion's verification
  (`status='verified'`, `verified_at=now()`), the `evidence.added` event and
  the audit row commit or roll back together. The criterion is only verified
  when the evidence carries a payload or a hash — a row is not a proof.
- **The inline text is stored once** (D‑056): in the `payload` column the gate
  reads, with `meta.inline_sha256` beside it, not twice.
- `local:` **not run** — the freeze still holds. The static half is green
  (build · typecheck 0 · eslint 0 · docs:check · the tests typecheck), and the
  tests themselves are written: `evidence-service.test.ts` (the shape check and
  the mask) plus four integration cases in `tests/integration/exec-tools.test.ts`
  (B.10 and B.16).
- `remote:` **not run** — local commits only, nothing pushed.

## PE-3 — the exit report and the finalization gate (C.1–C.11, C.9b)

- Scope: `exec_submit_exit_report` and `exec_task_complete` — the report that says what was
  done, and the one door to `done`. Both are `module: 'exec'` gated and thin: every rule lives
  in `@forgepm/core/src/exec`, so the tool, the gate and the projection cannot disagree.
- **The gate was split before it was wired** (C.11, and the debt the PE-2 handoff named):
  `packages/core/src/exec/gate.ts` was 590 lines, already over the plan's own bound. It is now
  268 lines of orchestrator (`evaluateGate`, `deriveStatus`, `runGate`, `composeFinalReport`)
  over `gate-types.ts` (the vocabulary), `gate-context.ts` (the loader), `gate-mappers.ts`
  (row → snapshot) and `gate-rules/rule01…rule13` (one file per rule, each under 60 lines).
  The numbering and the order are frozen and pinned by a test — a rule may be _added_ at the
  end, never renumbered.
- `packages/core/src/exec/exit-report.ts`: `parseExitReport` (strict `exitReportSchema` + the
  cross-field "explicit none" rule from `checkNoneConfirmed`) and `submitExitReport` (the report
  row, the promotion of every `incomplete`/`assumption`/`risk`/`not_run`/`out_of_scope` entry
  into `exec_open_items` with `source='exit_report'`, dedup by the C.4 key, and the
  `report.submitted` event). A missing field, an empty list without `none_confirmed`, and a
  `none_confirmed` that contradicts the list are all `UNPROCESSABLE`; a `tests_executed[]` entry
  that cites no `exec_evidence` row is `EVIDENCE_INVALID`.
- `packages/core/src/exec/task-complete.ts` + `gate.ts`: `runGate(tx, taskId, {reportId,
actorType})` runs the thirteen rules over a snapshot read out of the ledger and **writes the
  stamp into `exec_gate_checks` before the answer exists** — a refused close is evidence too.
  `completeTask` then moves the task to the status the gate implies (`deriveStatus`, pure and
  tested): `done` + `closed_at` on accept, `in_progress`/`awaiting_review`/`blocked` on refusal.
  Open items are **not** closed for the agent.
- `packages/core/src/exec/final-report.ts`: `buildFinalReport(tx, taskId)` — the completion
  report is rendered from the ledger, never from the agent's message; the message is quoted as
  one row among many.
- **I-1 (plan §8.3)**: `packages/core/src/modules/guards.ts` is the tiny registry (the core
  does not import the exec module — only the interface), `apps/api/src/modules/exec/module.ts`
  registers the `completionGuard` on enable, and `apps/api/src/modules/work-items/service.ts`
  consults it before a move to `category='completed'` — in the transition path _and_ in the
  PATCH, because the PATCH can carry a `state_id`. A work item that belongs to the ledger may
  only be completed once the gate has stamped its task; otherwise the answer is `GATE_FAILED`
  (409).
- **C.9b (drift)**: `packages/core/src/exec/drift.ts` is the single place that decides what
  "the task says done and the gate does not" means. `exec_ledger_status` and the gate both
  report `drift: gate stamp missing` (or `drift: gate stamp not passing`) in the same words —
  a hand-written `status='done'` cannot be prevented by an application, so it must at least be
  visible.
- Tests written (not yet run — see the local line below): 13 unit fixtures in
  `packages/core/src/exec/gate.test.ts`, one per rule, each asserting the whole answer
  (`rule`/`ref`/`needed`/`tool_to_call`); `deriveStatus`; the drift in three shapes; the
  exit-report completeness rules in `packages/core/src/exec/exit-report.test.ts`; the C.11 size
  bound in `tests/unit/exec-gate-size.test.ts`; 11 integration cases in
  `tests/integration/exec-tools.test.ts` (the report's refusals, the promotion and its dedup,
  `EVIDENCE_INVALID`, the gate's refusals, the clean close with its stamp, the completion
  report, "the gate does not close your items"); and the penetration test in
  `tests/integration/exec-completion-guard.test.ts` — the MCP `work_item_transition`, the REST
  transition (the panel's own path) and the REST PATCH all refuse with `GATE_FAILED`, and a
  hand-written `done` is reported as drift by both the status tool and the gate.
- **The ledger's own scopes are now real** (D-053): the plan's §4.0 gives the exec tools
  `ledger:read`/`ledger:write`, PE-2 had implemented them with the generic `read`/`write`, so the
  two ledger scopes were used by nothing and the enum's comment ("these are the agent's scopes")
  was false. The seven tools now accept **either** — §7's B.7 acceptance (a read-only key must not
  write) keeps holding, and a key can be granted the ledger alone; the panel's API-key form offers
  the two scopes so the grant is reachable.
- **The report's `scope_deviations` are filed, not dropped** (D-054): `changed_files` is what
  rule 11 measures; a declared deviation is the part the agent volunteers, so it becomes an
  `out_of_scope` open item with `source='exit_report'` and the completion report names it. It is
  deliberately _not_ a blocker — the plan's rule 2 blocks only on `blocks_completion` items, and a
  block with no waiver route would be a task that can never close. The real diff (PE-5) is what
  judges a deviation for real.
- **A closed task stays closed, a fake `done` is taken back** (D‑055): a `done` task with a
  passing stamp is refused by `exec_task_complete` (`LEDGER_STATE_INVALID`); a `done` task without
  one is drift — the gate reports it and the status (and `closed_at`) go back to what the gate
  implies. The stamp is the only thing allowed to decide what `done` means.
- **Every gate answer has the same shape** — `{rule, ref, title, needed, tool_to_call}` for all
  thirteen rules and for the drift, so an agent that reads `blocked_by[0].needed` never finds it
  missing on one rule and present on another. The pure `GateResult` also carries the completion
  report now (plan §8.2's `{ok:true, finalReport}`), composed from the very snapshot the gate
  judged.
- **Two things 0010 forced, and the code now obeys** (found by reading the schema before
  running anything, which is cheaper than finding them in a failed insert): `exec_gate_checks.report_id`
  is `NOT NULL REFERENCES exec_reports(id)`, so a stamp always belongs to a report — a task with no
  report is refused by rule 1 and leaves an `exec_events` row, not a stamp that points at nothing;
  and `exec_tasks` refuses `status ∈ {blocked, awaiting_review}` without `blocked_on_kind` +
  `unblock_condition` (≥ 10 chars) + `blocked_reason`, so the gate writes the unblock condition down
  when it sends a task back to a human.
- **Superseded by PE-8:** the earlier D-050 implementation read `changed_files` and
  `tests_executed` from the exit report. Rule 11 now uses the server-measured Git diff or a
  hash-only start manifest, and Rule 12 uses per-test CI outcomes tied to exact start/current
  commit SHAs. Agent report claims remain descriptive only and cannot satisfy either rule.
- **Local verification (authorized; 2026-10-18):** the selected PostgreSQL-backed exec suite
  passed all **84/84 tests across six files** (`exec-cli`, `exec-completion-guard`,
  `exec-human-actions`, `exec-human-path`, `exec-ledger-invariants`, and `exec-tools`). The first
  pre-repair run was 16 failed / 45 passed / 23 skipped; fixture repairs addressed workflow-state
  setup, JSONB serialization, enum values, task-scoped counts, evidence roots/refs, and secret
  cases. The rerun also exposed and fixed two product defects: a missing gate stamp was represented
  as a non-passing stamp in the gate (not as `drift: gate stamp missing`), and fact-promotion audit
  rows used an `F-…` code where the audit table requires the fact UUID. The passing run used
  embedded PostgreSQL 18 with `FORGEPM_TEST_NO_REDIS=1`; the six selected files contain no
  queue-backed tests. A subsequent full `npm run test:integration` with that same flag ran 29 files:
  **254 passed, 5 failed, 2 skipped**. All exec integration files passed. Four failed tests are
  queue enqueue attempts in `outbox`/`phase5-worker` with no Redis queue; the fifth is the backup
  endpoint, which cannot run the missing PostgreSQL client utility. Separately, `phase7-backup`
  setup fails because `psql` is absent, so its two cases are skipped. After the fixes, root `npm run lint`,
  `npm run typecheck`, `npm run test:unit` (**371/371 across 41 files**) and `npm run build` all
  passed. `npm run gen:api:check` confirmed the spec/client are current, `npm run schema:check`
  verified 60 contract tables, `npm run docs:check` passed (22 required docs), and `git diff --check`
  passed. This replaces the earlier no-test/unknown-verdict snapshot above.
- `remote:` **not run** — no push, GitHub CI, or merge is authorized. PR #13 was not touched or
  rechecked in this continuation; the last recorded state remains open, mergeable and green
  (run 39121664724, 25/25 steps).
- **The audit round (no test run, reading only).** With the freeze in place the PE-3 tree was read
  against the plan and against itself, which found four things a test would have found later and
  that are fixed now: the C.11 size test could not read the six rules written as an expression body
  (it threw instead of measuring); the exit report's `none_confirmed` accepted only the literal
  `true`, so an agent that answered "not none" with `false` was refused with a schema error instead
  of a sentence about the field (now a boolean, and the law stays in the cross-field check); a
  hand-written `status='done'` could be "closed" by a second `exec_task_complete` call (D-055: the
  stamp decides, and `closed_at` goes back with the status); and the drift test wrote a `done` task
  without `closed_at`, which the table's own CHECK forbids.

## PE-5 — risk policy + exec_events (F.1–F.9)

**Feature commit: `f44ce92` on `arena/e737b1f8-forgepm` (based on `14c4270`); tests and CI remain frozen by the user's instruction.**

- The `EXEC_POLICY_DEFAULT` rules and operator-facing notes are now locked by a full 27-row golden
  snapshot. `classify` treats `reversible=false` as at least `review`, including an explicit `none`;
  sensitive categories still rise to `approval`, and hard-deny categories/commands still dominate.
- `policy:set --from <file>` (plus `npm run policy:set` and `npm run policy:print`) now uses the same
  settings REST path as the panel. `validateSettingValue('exec.policy', …)` enforces duplicate,
  required-category and hard-deny constraints on writes; enabling exec reuses that validation.
  `getEffective` has no policy cache, so the next call sees the update immediately. An integration
  scenario exercises set → `exec_policy_check` review-to-approval → print.
- Gate rule 4 now also sees an applied decision when a **done** journal entry's `target` is exactly
  that decision's ledger code (`D-…`); unrelated journal targets do not match. Tests cover
  `db_schema` pending/approved, the rationale claim being ignored, and a rejected decision whose
  journal target is done.
- Denied policy checks for `write_secret`, `delete_root_folder` and `rm -rf /` append
  `exec_events(action='policy.denied', payload.outcome='blocked')`; integration coverage is written.
- `scripts/claude-hook.mjs` consumes Claude Code `PreToolUse` JSON: `git push` and `Edit` on any
  `package.json` return `ask`; `rm -rf` returns `deny`; unrelated actions return `{}`. A subprocess
  unit test checks actual JSON stdout, including malformed input failing closed. The optional
  `.claude/settings.json` sample remains PE-6 work; the hook is not wired into this repo's local
  Claude configuration.
- **Local verification after the user's local-only authorization:** `npm run lint`, `npm run typecheck`,
  and `npm run build` passed. The first unit run exposed four failures plus one suite-load error;
  fixes made the rule-6 gate tolerate malformed report shape (rule 1 reports it), corrected the
  missing-file evidence fixture to stay inside an allowed root, gave the valid test-output fixture
  real output, and made both structural scanners recurse into nested gate-rule files. The targeted
  five files passed (73/73), then the full unit suite passed: 41 files, 371/371 tests. The Angular
  suite also passed (5 files, 77/77 tests; 94.74% statements, 91.82% branches, 89.88% functions,
  95.53% lines). `apps/web`'s local ESLint config was corrected to provide Node globals for scripts
  and defer TS undefined-name checks to the compiler; its full `npm run verify` then passed (lint,
  contrast, raw-value, build). The selected exec suite and the later full PostgreSQL integration
  attempt are recorded under PE-3 below: all exec files pass; the full run reports 254 passed, 5
  environment-bound failures, and 2 skipped because Redis and PostgreSQL client utilities are
  absent. API drift, migration, and schema-contract checks passed against the disposable local
  PostgreSQL environment. E2E and performance checks remain unrun. GitHub CI was not triggered; no
  push or merge occurred.
- **Next:** a Redis server plus `psql`/`pg_dump` are needed for a clean full integration run; E2E and
  performance checks also remain. D.3 separately needs secure live URL/key configuration and three
  genuine task references. PR #13 was not touched; its status was not rechecked.

## PE-6 — agent ledger rules and MCP connection docs (D.1–D.5)

- Added the ≤80-line Persian trigger-to-tool guide, four reasoned prohibitions, six CLI examples, and
  the start/resume, ask-human, evidence, and exit-gate workflow. Added a unit guard for line count,
  mappings, and the four prohibition/reason pairs; its three assertions passed in the newly authorized
  local unit run, verifying D.1/D.2.
- Added the concise `AGENTS.md` execution-control section. Manual review found no conflict with
  `docs/EXECUTION_PLAN.md`; D-060 records the behavior policy.
- Corrected inbound MCP docs to Streamable HTTP only (`POST /mcp`). The repository has no stdio
  proxy executable; `forgepm-mcp` is `serverInfo.name`. Corrected the execution-agent scope guidance
  (`ledger:read` + `ledger:write`, project-restricted, never `ledger:decide`) and documented the
  current single-scope API Keys UI limitation. D-061 records the resolution; no bridge was added.
- D.3 remains **not run**. The user authorized this field exercise, but a presence-only preflight
  found required `FORGEPM_URL` and `FORGEPM_API_KEY` unset, and no project/task references were
  available. No API request was sent. (`DATABASE_URL` was also unset but is not needed for a remote
  field run.) Local unit tests do not count as D.3 evidence; no observations or trigger rate are
  claimed. `docs/EXECUTION_CONTROL_PLAN.md` leaves D.3 open.
- D.4 rechecked locally: `npm run docs:check` passed (22 required docs; links resolve) and
  `node apps/web/scripts/i18n-check.mjs` passed (199 keys). Latest root `lint`, `typecheck`, and
  `build` passed; `npm run test:unit` passed all 371 tests across 41 files, including the D.1/D.2
  guard. Against embedded PostgreSQL, `npm run migrate` was up to date, `npm run gen:api:check`
  passed, and `npm run schema:check` verified 60 contract tables; the selected DB-backed exec suite
  passed 84/84 (details under PE-3). The full integration run was attempted and reported 254 passed,
  5 environment-bound failures and 2 skipped (four queue failures without Redis, one backup failure
  without PostgreSQL client utilities, and the `phase7-backup` suite could not set up without
  `psql`). Full `npm run verify`, E2E, and performance checks remain unrun. GitHub CI, push, and
  merge were not run.

## PE-7 — adversarial review (E.1–E.8)

- Implemented the isolated five-section review input, bounded and witness-validated output parser,
  six fixed review lenses, provider orchestration, review/AI/audit persistence, and one corrective
  output retry. The reviewer has no tool interface and does not update source files or work items.
- Added the bounded read-only Git source under `exec.allowed_repo_roots`. It computes the diff and
  content/mode tree hash, fails closed on invalid or oversized input, and is the only narrowly
  permitted `execFile` use in execution-control. D-062 records that repository code is never run.
- Added `review_task` and documented its MCP input, statuses, budgets and failure behavior. Provider
  calls—including retries and budget refusals—are accounted for in `ai_calls`; the run is limited to
  two rounds. A final failure creates a reviewer-sourced arbitration item.
- Rule 7 accepts a failed verdict only after a human resolves the exact reviewer arbitration item;
  its `related_ref` is bound to task, review round and tree hash. A lookalike finding, agent closure,
  older arbitration item, stale hash or other active blocker cannot authorize completion. Stale runs
  before the final round do not create an arbitration item. Unit coverage checks each guard; the
  PostgreSQL scenario exercises two rounds and human resolution.
- **Local verification (2026-10-18):** `npm run build`, `npm run typecheck`, `npm run lint`, and
  `npm run test:unit` passed (43 files / 380 tests). The main PostgreSQL-backed execution batch passed
  seven files / 90 tests (`exec-review` plus the six existing execution integration files), with
  `FORGEPM_TEST_NO_REDIS=1`. After provenance hardening, the affected `exec-review` suite was rerun
  and passed 6/6. Embedded PostgreSQL was stopped after each batch. Post-edit checks also passed:
  `docs:check` (22 docs/links), `migrate` (up to date), `schema:check` (60 tables), `gen:api:check`,
  `check-migration-hashes`, and `git diff --check`. No D.3 API request, push, GitHub CI, or merge
  occurred.

## PE-8 — measured scope and CI baseline (J.1–J.8)

Status: **implementation, operator documentation, and local verification complete** (2026-10-18 UTC).

- `npm run build`, `npm run typecheck`, `npm run lint`, and `npm run test:unit` passed; the unit suite
  reports 46 files / 404 tests. The selected PostgreSQL-backed execution integration batch passed
  seven files / 90 tests, and the PE-8 scope/baseline file passed 3/3 on a focused rerun (93 tests
  across the eight selected files). The first run exposed code-vs-UUID task-reference lookups that
  were fixed by comparing `id::text`; the scope assertion now counts both an added and a deleted file.
- `docs:check` passed (22 required docs and links), `migrate` is up to date, and `schema:check`
  verified 60 contract tables. `npm run gen:api` refreshed the OpenAPI spec/client after tool
  registration; `gen:api:check`, migration hashes (9 migrations), and `git diff --check` passed.
- Verification was local only. No D.3 API request, push, remote CI, or merge occurred.

- Rule 11 uses the API's read-only Git diff from a server-captured start SHA, or a two-pass,
  bounded, hash-only manifest captured at task start when Git/commit is unavailable. Report
  `changed_files` claims are ignored. Manifest provenance is system-authored and validated at gate
  time; the walker excludes Git/dependency/generated directories, includes file mode in regular
  digests, and refuses symlinks resolving outside the worktree.
- Scope measurement waivers are human-only and now rejected while scope is measurable. Human scope
  expansion is audited; it cannot clear deletions, and Gate rule 11 still blocks measured findings
  even if a waiver was previously recorded.
- Rule 12 reads named per-test outcomes only from bounded HTTPS CI envelopes whose SHA matches the
  server-measured start/current commit. Redirects are rejected, the SSRF guard fails closed for CI
  DNS errors/private targets, and raw logs/tokens are not stored or returned. A system-authored
  start-run event anchors row provenance; recaptures preserve that start provenance. Missing logs
  require a human baseline waiver, which cannot bypass measured red CI or test weakening. ForgePM
  does not run repository tests, builds, scripts, or other code.
- Added unit coverage for Git/manifest source boundaries, DNS/secret header safety, totals-only and
  skip-only parsing, CI provenance and measured `.skip` weakening. New PostgreSQL integration
  coverage exercises manifest scope expansion/deletions, unavailable-only human waivers, exact-SHA
  CI capture, repeated-capture provenance preservation, secret/log non-persistence and report-claim
  rejection. Updated the plan, MCP contracts, security/runbook docs and decision record D-063.

**PE‑8 carry-forward:** D.3 remains unrun until secure endpoint/key configuration and three
genuine task references are available. Do not push, trigger remote CI, or merge.

## PE‑9 — requirements and plan (G + H)

Status: **implementation and focused local verification complete** (2026-10-18 UTC).

- `npm run build`, `npm run typecheck`, and `npm run lint` passed. The unit suite passed 49 files /
  417 tests. The selected PostgreSQL-backed batch passed 5 files / 80 tests, including the new
  requirements/planning integration coverage, human-only cancellation route, human answer path,
  dispatch inventory, and successful task completion with dependency resumption. `docs:check` (22 docs),
  migration status (up to date), `schema:check` (60 tables), OpenAPI generation/check (95 paths),
  migration hashes (9 files), and `git diff --check` also passed.
- Requirement tools enforce checkable text and exact user-message quotes; `req_ids` remain
  declarations only, with criterion `req_id` as the sole coverage link. Unassigned active
  requirements are returned by `session_start`/`exec_plan_view` and block task creation. Changes
  reopen linked criteria as `pending`, retain evidence as append-only history, mark dependent
  decisions `needs_revisit`, and reopen completed tasks with blockers. Explicit conflicts create a
  blocking design gap and a human question.
- Planning rejects dependency cycles, reports pending dependency codes on refused starts, persists
  blocker state, and resumes tasks after the matching human answer/approval or dependency completion.
  `session_start` reports uncovered requirements and automatic unblocks; `exec_plan_view` returns the
  task tree with distinct `blocked` and `awaiting_human` statuses. Child cancellation is human-only,
  approval-backed, and recorded for the parent gate. No new migration or requirement↔task table was
  added.
- The broad integration invocation exposed audit calls passing task/requirement codes where the
  audit table requires UUID resource IDs; those PE-9 defects and the corresponding answer/blocker
  test fixtures were corrected before the focused rerun. Unrelated broad-suite failures require
  Redis, `psql`, or `pg_dump` and are not claimed as passing. The PE-9-focused batch passed 80/80 in
  one PostgreSQL test lifecycle. No remote CI, push, merge, or D.3 API request occurred.

## PE‑10 — resume and journal (K)

Status: **implementation and focused local verification complete** (2026-10-19, Asia/Tehran).

- `journal_start` captures a bounded, server-measured Git pre-state; `session_start` transitions
  interrupted `started` rows to `unknown` with event/audit evidence and ranks unknown rows first.
  The dispatch lock blocks ordinary agent writes with `JOURNAL_UNRESOLVED`, while reads, settlement,
  human questions, reconciliation, and policy-computed approval decisions remain available. A retry
  requires one unknown idempotent row with an exact task/action/target/expected-effect match and is
  recorded as `journal.retry_started`.
- Forward-only migration `0011_exec_journal_reconcile` allows only
  `started → unknown → done|failed`, keeps journal targets immutable, and adds a nullable hash-only
  close manifest to the append-only Gate stamp. Reconciliation compares only the closed task's
  `allowed_paths` against current per-file hashes, and reports stale facts, unsettled journals, and
  measured Git diffs versus exit-report `changed_files` claims.
- `session_start` emits all six fixed-priority sections with omission counts/read hints; its effective
  budget is clamped below MCP's 50 KiB dispatch cap even when `exec.session_output_max_bytes` is
  larger. The `SessionSnapshot` output contract is tested. No optional shell/editor hook is installed.
- **Local verification:** build, typecheck, lint, unit tests (49 files / 425 tests), migration status
  (up to date), schema contract (60 tables),
  OpenAPI/client freshness, docs check (22 docs), migration hashes (10 migrations), and diff check
  passed. The selected PostgreSQL-backed execution batch passed **109/109 tests across 10 files**;
  this included K.1–K.7 and the journal trigger invariants, using one embedded PostgreSQL lifecycle.
  This is not a claim that the full integration project passed; unrelated suites need Redis or
  PostgreSQL client utilities.
- PE‑9 decisions remain intact: `exec_criteria.req_id` is the only requirement-coverage link; no
  requirement↔task table or PE‑9 migration was added. D.3 remains unrun until secure endpoint/key
  configuration and three genuine task references are available. Remote CI, push, and merge were
  not run.

## PE‑11 — project facts and evidence (I)

Status: **implementation and focused local verification complete** (2026-10-19, Asia/Tehran).

- Added the four fact MCP tools. `fact_record` rejects guess-as-fact, inspects and hashes named
  sources, and preserves duplicate-key history through `superseded_by`; `fact_query` keeps stale
  status explicit with warnings; `fact_promote` is human-only, requires a meaningful reason, and
  records the human approval/audit trail. File and commit references are checked before writes.
- Hash drift is checked during `session_start` (unless `exec.stale_check_on_start=false`), before
  `exec_task_complete`, and by the worker's idempotent 15-minute reconciler (D-064). Stale facts
  move dependent active decisions to `needs_revisit`, create blocking risk items, and are visible in
  the next session/query. Explicit verification can reactivate a matching fact, but not its decisions.
- No migration was needed: `0010_exec` already provides the file hashes, verification timestamp,
  statuses, supersession link and relevant constraints/index. Updated the plan, MCP contracts,
  ledger rules, schema contract, changelog and D-064.
- **Local verification:** build, typecheck, lint; unit tests **430/430** (50 files); focused
  PostgreSQL-backed integration batch **107/107** (9 files), including I.1–I.7, periodic worker
  verification, the pre-completion check, human promotion compatibility and PE-9/PE-10 regression
  coverage. Migration status was up to date; schema contract (60 tables), docs check (22 docs),
  migration hashes (10), OpenAPI/client freshness and `git diff --check` passed. PostgreSQL was
  stopped and its temporary data directory removed. The full integration project and remote CI were
  not run.
- PE‑9 decisions remain intact, and PE‑10 K.1–K.7 remains historical completed work. D.3 remains
  open pending secure endpoint/key setup and three genuine task references. No push, merge, or
  remote CI trigger occurred.

**Next:** PE‑12 by phase priority. Keep D.3 open; do not push, trigger remote CI, or merge.

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
- `remote:` **pass** — PR #13 (`arena/e737b1f8-forgepm`, the fresh session the PE-2 handoff asked
  for), run 39120040693: all 22 steps green, including the full `npm run verify` with its coverage
  thresholds, the gen:api drift check, the Angular build + Playwright flagship E2E, the performance
  budget and the docker-compose health smoke. The earlier `cannot-run` verdict — this session's
  branch was closed to GitHub, so CI had never seen the tree — is superseded: CI has seen it now, and
  it saw the integration half with Redis, which the local half could not run.
- Recorded on `arena/c216c536-forgepm` as `caa59db` — 79 files, the re-materialised PE-0 + PE-1 +
  PE-2 tree (the sandbox was reset twice and rewound git to `bc6f28b`, deleting the earlier local
  commit). The sha is written down here precisely because a reset can take it out of git again.
  That tree is now on GitHub as PR #13 (`arena/e737b1f8-forgepm`), so the work is no longer only
  local. `docs/PHASENaN_REPORT.md` was deliberately left untracked: it is a stale `report:phase`
  artifact titled "Phase NaN" with a `local: fail` verdict that belongs to no phase, and committing
  it would pass off a leftover as evidence.
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

# Changelog

All notable changes to ForgePM, per plan phase. Format loosely follows
Conventional Commits groupings. Tags map to plan §17.

## [Unreleased] — Panel UI/UX upgrade (2026-10-21)

- fix(api): keyset pagination (jobs, audit, MCP calls, users, projects, work items) no longer skips rows that share a cursor millisecond — the cursor now keeps microsecond precision; ISO cursors from before still work.
- feat(web): the API keys page shows copy-ready MCP connection samples (Claude Code command, `.mcp.json`, smoke test) and an "MCP agent scopes" preset.

- feat(web): API keys page — several scopes per key (checkboxes, no `ledger:decide`), Active/Revoked/Expired badges, revoked keys hidden behind a switch, revoke asks for confirmation. Revoke itself always worked (it sets `revoked_at`); the list just did not show it.
- feat(web): saved acceptance criteria are shown on each feature row and can be ticked.

- feat(web): panel redesign — System page dissolved (Jobs page, health on Projects, Modules/Backups/GitHub status/Appearance in Settings with search), create forms as modals (features, milestones, work items, projects, providers), portrait project cards with an Active label, status badges with colour/icon/CamelCase, counts in badges, header shows the active project, theme and language live in Settings.
- feat(api): list and disconnect project repositories (D-069); the GitHub page shows connected repositories with link/unlink icons and a search filter.

- feat(web): edit project details (name, description, priority, dates) from the Projects page; the key stays read-only; archived projects restore from the Archived section.
- fix(api): work-item list no longer returns 500 when ledger-written acceptance criteria are plain strings.
- test(api): API keys are always `agent` for the ledger (R-02 regression); seed fills `exec.protected_test_globs` and `exec.test_command`.

- feat(cli): `forgepm` command (root `bin`, `npm link`) starts api, worker and panel from any directory.

- feat(github): `installation` / `installation_repositories` deliveries register the installation's repositories (idempotent, never deleted) — D-068.
- feat(web): API errors surface as toasts instead of duplicated inline messages; System page health cards and module toggle switches.

- feat(web): grouped sidebar shell (Workspace → Project → Delivery → Governance → Platform) with a global project switcher, ⌘K search trigger, theme/language controls and an off-canvas mobile drawer.
- feat(web): step-by-step gating — project-scoped sections (Dashboard, Features, Work items, Planner, Execution, Reviews, GitHub) are hidden and their routes redirect to `/projects` until a project exists and is selected.
- feat(web): new `/dashboard` — KPI cards, state donut, priority/type bars, feature + milestone progress, items needing attention, latest items, recent audit events, getting-started checklist (dependency-free SVG charts in `ui/charts.ts`).
- feat(web): redesigned Projects (onboarding hero, project cards, archived group), Features/Milestones (progress cards) and Planner (goal → generate → approve → apply stepper).
- style(web): refreshed tokens (canvas, soft lines, chart palette, radii/shadows) in light and dark; cards, tables, tabs, board and inputs restyled; contrast and raw-value gates still pass.
- style(web): remaining pages moved to the card layout — Approvals, AI providers, API keys, Audit/Users, MCP, System (health tiles), Settings (project tab only with a project), Reviews, GitHub, Execution policy, Work items (create form first, toolbar).
- test(web): shell specs cover gated vs unlocked navigation; e2e `login()` waits for the shell instead of the Projects page. Visual-regression snapshots need regenerating (`apps/web/e2e/visual.spec.ts-snapshots`).

## [Unreleased] — Execution control fixes (2026-10-21)

- fix(exec): every API key is a ledger *agent* (user-owned keys were recorded as `human`).
- fix(hooks): PreToolUse also guards Write/Edit/MultiEdit of package.json, `.env*`, hook and settings files.
- fix(exec): clearer error when Git refuses a worktree for ownership; test no longer needs real DNS.
- fix(security): neutralize repo-config `filter.*` (clean/smudge/process) in the exec Git source (R-05); the hardening only covered lfs.
- feat(cli): `ledger-cli` logs in as a human session (`FORGEPM_EMAIL`/`FORGEPM_PASSWORD`, CSRF) — R-02 refuses every API key on deciding verbs.
- chore(seed): dev seed fills `exec.allowed_repo_roots` when unset.
- test(e2e): `scripts/exec-e2e.ts` rewritten against current tool contracts (13/13); previously 8 scenes failed or passed by faking state.
- Open items and limits: `docs/EXEC_CONTROL_FIX_REPORT.md`.

## [Unreleased] — Execution control, PE-12 panel + E2E (2026-10-19)

Full panel and 13-scene proof: `pages/exec-tasks.ts` (tree, cursor pagination,
project picker, blocked/awaiting_human coloring, drawer with criteria/evidence
provenance, open items/decisions/questions/reviews/journal/REQs, Dry-run Gate
with blocked_by), `pages/exec-policy.ts` (editable exec.policy with zod +
diff, admin), WorkItem Execution control (gate status + recent exec_events,
Done disabled with tooltip + server FORBIDDEN guard), Approvals ledger rows
with task link and the six exec kinds. i18n fa/en parity for new keys
(248 keys, `i18n-check` green), RTL/360/1280 no-overflow, contrast 52 pairs.
`scripts/exec-e2e.ts` 13 scenes (12 REQs, uncovered→REQUIREMENT_UNCOVERED,
task_split dependency, later→OI, public_api approval, early complete ok:false,
out-of-scope, baseline vanish→rule 12, fact stale→needs_revisit, journal
unknown→retry, review TODO, human unlock via CLI+panel, final done+report)
and `ledger snapshot --out .agent-ledger/status.json` (advisory_only, TTL).
Docs: README Execution control, DATA_MODEL §H 17 tables, API `/api/v1/exec/plan`,
MCP 28 tools, SECURITY no-exec, RUNBOOK baseline, DECISIONS D-01…D-13.
`npm run build/typecheck/lint/docs:check/migration-hash/i18n-check/contrast/raw-value`
green; `npm run exec:e2e` harness green; no better-sqlite3.

## [Unreleased] — Execution control, PE-3–PE-11 (2026-10-19)

The exit report and the finalization gate: the report that says what was done, and the
one door to `done`. Two tools, thirteen rules, one stamp. No new migration (D-047) — the
tables (`exec_reports`, `exec_gate_checks`, `exec_tasks.gate_stamp_id`) were already there.

### Added

- **PE‑11 project facts and source verification (I.1–I.7)** — added `fact_record`, `fact_query`,
  `fact_verify`, and human-only `fact_promote`. Code reads and hashes named source files; file and
  commit refs fail closed when uninspectable; duplicate keys supersede without deleting prior rows.
  Hash drift is checked at `session_start`, before task completion, and by a periodic worker pass;
  stale facts move dependent decisions to `needs_revisit`, create blocking items, and remain visibly
  stale with a query warning. The idempotent 15-minute reconciliation is documented in D-064. No
  migration was needed; the existing `exec_facts` columns and checks already support the lifecycle.
  Local verification results are recorded in `docs/PROGRESS.md`.
- **PE‑10 session recovery and action journaling (K.1–K.7)** — added server-captured Git pre-state,
  journal start/done/fail, session recovery from `started` to `unknown`, and a dispatch-enforced write
  lock with narrow recovery exceptions. Exact idempotent retries match task/action/target/expected
  effect and append `journal.retry_started`; Gate rule 13 blocks `started` and `unknown` rows.
  Forward-only migration `0011_exec_journal_reconcile` updates the settlement trigger and adds
  hash-only close manifests. Reconciliation checks task-scoped post-close file drift, stale facts,
  unsettled journals, and measured Git diffs against report claims. `session_start` preserves all six
  priority sections within the configured budget and the 50 KiB MCP cap; the `SessionSnapshot`
  schema is tested, with no optional hook installed. Local verification passed: build, typecheck,
  lint, 425 unit tests, the focused PostgreSQL-backed execution batch (109 tests / 10 files), migration
  status, schema contract (60 tables), OpenAPI/client freshness, docs check (22 docs), migration hashes
  (10 migrations), and diff check. The full integration project and remote CI were not run; no push
  or merge occurred.
- **PE‑8 measured scope and CI baseline (J.1–J.8, D‑063)** — Rule 11 now ignores
  agent-authored file lists and compares the server-measured Git diff with `allowed_paths`; on
  Git-less installs the API captures a bounded two-pass hash-only start manifest. Measurement
  provenance is validated at gate time, and measured out-of-scope files/deletions cannot be
  bypassed by a scope-measurement waiver. Rule 12 now records named per-test outcomes only from
  bounded, redirect-free HTTPS CI logs for the exact server-measured start/current SHAs; logs and
  tokens are not persisted, the initial run provenance is preserved across recaptures, and missing
  evidence requires a human waiver. Added `baseline_capture`/`scope_check`, SSRF and source-boundary
  hardening, Gate version 2, unit and PostgreSQL integration coverage, and updated the plan, MCP,
  security, runbook and decision documentation. Local verification passed: build, typecheck, lint,
  404 unit tests, and 93 selected execution integration tests across the eight-file batch and PE-8
  focused rerun; docs, migration, schema, OpenAPI generation/check, migration-hash and diff checks
  also passed. No D.3 request, remote CI, push, or merge occurred.
- **PE‑9 requirements and planning (G + H)** — added `req_add`, `req_link_task`, `req_change`,
  `req_coverage`, `task_split`, `task_start`, `task_block`, `exec_link_dep`, `exec_plan_view`, and
  the PE-9 `session_start` projection. Exact quotes and shared checkability rules are enforced;
  `exec_criteria.req_id` remains the sole coverage link, while task `req_ids` are declarations.
  Requirement changes reopen criteria without rewriting append-only evidence, flag dependent
  decisions `needs_revisit`, and add blockers for reopened completed tasks. Explicit conflicts open a
  blocking design gap and human question. Dependency cycles/pending starts are refused, blockers
  resume after their matching human response or dependency completion, and linked-child cancellation
  is human-only with an approval-backed parent-gate waiver. No migration or requirement↔task table was
  added. Local verification passed: build/typecheck/lint, 417 unit tests, the focused PostgreSQL-backed
  integration batch (80 tests / five files), docs check (22 docs), migrations up to date, schema check
  (60 tables), OpenAPI generation/check (95 paths), migration hashes, and diff check. The broad
  integration project is not claimed as green because unrelated suites require Redis and `psql`/
  `pg_dump`. No remote CI, push, merge, or D.3 API request occurred.
- **PE‑7 adversarial review (E.1–E.8, D‑062)** — added `review_task` over five isolated ledger
  sections and a bounded, read-only Git diff/hash; the model has six fixed lenses and no tools.
  Witness-bound parsing permits one corrective retry, records provider/token usage, and persists
  reviewer findings as blocking ledger items. Reviews are bound to a worktree hash and capped at two
  rounds; the human arbitration reference binds task, round and hash, and cannot bypass freshness or
  other active blockers. Local checks passed: build, typecheck, lint, 380 unit tests, the selected
  PostgreSQL-backed execution integration batch (90 tests / seven files), a 6/6 `exec-review` follow-
  up after provenance hardening, `docs:check`, migration, schema (60 tables), API-generation drift,
  migration-hash, and diff checks. No D.3 call, push, GitHub CI, or merge was run.
- **PE‑6 agent execution rules and MCP setup docs (D.1–D.5)** — added the ≤80-line
  trigger-to-tool guide, four reasoned prohibitions, `AGENTS.md` execution-control rules, and
  scope-limited Streamable-HTTP setup. Corrected the nonexistent stdio-proxy claim; no bridge was
  added (D-060/D-061). D.1/D.2's three local guard assertions passed. D.3's three-real-task run
  remains **not run**: although authorized, required `FORGEPM_URL`/`FORGEPM_API_KEY` configuration
  and real task references were unavailable, so no API request or task run occurred and no pass rate
  is claimed. Docs/i18n, lint, typecheck, build, 371 backend unit tests and 77 Angular unit tests
  passed after fixing the malformed-report guard, evidence fixtures, recursive structural scanners,
  and the web-local ESLint globals (details in `docs/PROGRESS.md`). The selected DB-backed exec
  suite passed 84/84 tests. A full integration attempt then reported 254 passed, 5 environment-bound
  failures and 2 skipped with Redis and PostgreSQL client utilities unavailable; GitHub CI was not
  run.
- **PE‑5 risk policy and hook controls (F.1–F.9)** — the default risk table is pinned by a
  complete golden snapshot; `policy:set --from file.json` writes validated organization/project
  policy through the existing settings API, and the next `exec_policy_check` reads it directly
  from Postgres (no stale in-process cache). Irreversible `none` claims now require review;
  rejected decisions applied by a completed journal entry are caught by Gate rule 4. Denied
  policy checks append `policy.denied` events with `outcome='blocked'`. The standalone
  `scripts/claude-hook.mjs` asks before `git push` or package-manifest edits and denies recursive
  forced deletion; its five-case subprocess unit test passed locally.
- **`exec_submit_exit_report`** — the report is strict and complete: every field must be
  present, and each of the eight "none" fields must either list its entries or be confirmed
  empty (`none_confirmed.<field>=true`). A dropped required field is rejected at tool-schema
  validation with MCP code `VALIDATION_ERROR` (the message names the missing field); an empty list
  without confirmation or a confirmation that contradicts the list is `UNPROCESSABLE` — "I forgot to mention it" and
  "there was nothing to mention" are different statements, and only the second one may be made
  silently. Every `incomplete` / `assumption` / `risks_found` /
  `tests_not_run` / `out_of_scope_findings` entry is filed as an `exec_open_items` row with
  `source='exit_report'`, in the same transaction as the report, deduplicated by the C.4 key.
  A `tests_executed[]` entry that cites no existing `exec_evidence` row is `EVIDENCE_INVALID`.
- **The rest of the human path (PE‑4, plan §9.5, D‑058/D‑059)** — the verbs the
  plan's tool table gives to nobody but a human: waive a criterion, drop a
  requirement, widen a task's scope, promote a guess into a fact, and ask the
  gate "may this close?" without closing anything (`POST /exec/gate/:taskId`
  writes nothing — no stamp, no report status, no event). Each of them leaves
  a decided row in the approval queue with the ledger's own code and task, so
  the six kinds (`exec.decision|question|scope_expansion|waive_criterion|
drop_requirement|fact_promotion`) are one list a human can read.
- **A crash found by reading the code (D‑058)** — the gate's snapshot loader
  queried `exec_req_tasks`, a table **no migration ever created** (D‑049 #2 had
  already dropped the requirement↔task table in favour of the criterion's own
  `req_id`). Every gate run would have failed on a missing relation. The link
  now comes from the criteria, and the phantom table is gone from the code and
  from the DB interface.
- **`scripts/ledger-cli.ts` (PE‑4, plan §9.5, D‑11)** — the human's command line:
  `list`, `show <T>`, `resolve <OI> --status --note`, `answer <Q> "…"`, `approve/reject <D>`,
  `waive <C>`, `req drop <REQ>`, `approve-scope <T>`, `fact promote <F>`, `policy print|set`.
  It speaks to the same `/api/v1/exec/*` routes the panel uses, with `FORGEPM_URL` +
  `FORGEPM_API_KEY` — it NEVER connects to the database, because a tool that can reach
  the DB can do what the human's key is not allowed to do. The output is at most one page
  (40 lines) unless `--json` is passed.
- **The human path (PE‑4, plan §9.5)** — four REST routes under `/api/v1/exec/*`:
  `GET /exec/status` (the panel's projection — the same one the tool returns), `POST
/exec/items/:code/resolve`, `POST /exec/questions/:code/answer` (the task leaves
  `awaiting_review`) and `POST /exec/approvals/:id/decide` — where "the human approved" finally
  reaches the ledger: the decision's `approval_state` flips and the `decision.approved` event is
  written, in the same transaction as the approval itself. The mutating routes need the human-only
  `ledger:decide` scope, and an agent is refused in the handler as well.
- **`exec_policy_check` (PE‑4, plan §9.4)** — "what would the policy say about this?", answered
  by the same table that decides: the level, matched rules, and next tool. It creates no decision
  or approval; only a denied action appends a `policy.denied` event so the blocked attempt is auditable.
- **`ledger_record_decision` and `ledger_ask_human` (PE‑4, plan §9.2/§9.3)** — the two ways an
  agent involves a human: a decision whose RISK is computed from the policy table (the agent may
  not send its own level, an approval-level decision is stored `pending` and says
  `do_not_apply_until_human_approval:true`, a denied one is not recorded at all), and a question
  whose options each carry their impact. A blocking question parks the task in `awaiting_review`,
  and there is no timeout: silence is not approval.
- **`ledger_add_evidence` (PE‑4, plan §9.1)** — the write path that makes "a claim without
  proof is forbidden" true: the ref is READ before anything is written (a path that is not
  there is `EVIDENCE_INVALID`, a test log with no result line is a paraphrase, a path outside
  `exec.allowed_repo_roots` is a `SCOPE_VIOLATION`), secrets are masked on the way in (B.16),
  and the evidence, the criterion it verifies and the ledger event commit together.
- **A declared `scope_deviations` entry is filed as an `out_of_scope` open item**
  (D-054), with `source='exit_report'` like every other finding: the report's
  `changed_files` are what rule 11 measures, and the deviation is the part the
  agent volunteers — the ledger must not drop it.
- **A closed task stays closed, and a hand-written `done` is taken back** (D-055):
  `exec_task_complete` refuses a task that is `done` with a passing stamp
  (`LEDGER_STATE_INVALID`), and a task that says `done` WITHOUT a stamp is
  drift — the gate reports it and the status goes back to what the gate
  implies, `closed_at` included.
- **`exec_task_complete`** — the single gate. It runs the thirteen rules against a snapshot
  read out of the ledger, writes the stamp into `exec_gate_checks` **before** the answer
  exists (a refused close is evidence too), and only then moves the task: `done` +
  `closed_at` on accept, `in_progress` / `awaiting_review` / `blocked` on refusal. A refusal
  is an answer, not an error: `{ ok:false, blocked_by:[{rule,ref,needed,tool_to_call}] }`.
  Open items are **not** closed for the agent, and the completion report is rendered from the
  ledger (`buildFinalReport(tx, taskId)`), never from the message.
- **`packages/core/src/exec/gate-rules/`** — the thirteen rules, one file each, each under 60
  lines. `gate.ts` was 590 lines (already over the plan's own C.11 bound) and is now 268
  lines of orchestrator over `gate-types.ts`, `gate-context.ts` and `gate-mappers.ts`. The
  numbering is a public contract: a rule may be added at the end, never renumbered.
- **`packages/core/src/modules/guards.ts`** — the completion-guard registry (plan §8.3, I-1).
  The core does not import the exec module, only the interface. The exec module registers
  its guard on enable, and the work-item service consults it before a move to
  `category='completed'` — in the transition path _and_ in the PATCH, which can carry a
  `state_id`. A work item with a ledger task behind it may only be completed once the gate
  has stamped that task; otherwise the answer is `GATE_FAILED` (409).
- **`packages/core/src/exec/drift.ts`** — one place that decides what "the task says done and
  the gate does not" means. `exec_ledger_status` and the gate both report
  `drift: gate stamp missing` (C.9b) in the same words, so a hand-written `status='done'` is
  at least visible.

### Changed

- **The ledger tools take the ledger's own scope, or the generic one** (D-053): the plan's
  §4.0 gives every execution-control tool `ledger:read` / `ledger:write`, and PE-0 added those
  scopes to the enum with the comment "these are the agent's scopes" — but PE-2's five tools
  were implemented with the generic `read` / `write`, so the ledger scopes were used by nothing
  and the comment was false. All seven tools now accept **either**, which keeps §7's B.7
  acceptance (a read-only key must not write) intact and makes a ledger-only grant possible for
  the first time; the panel's API-key form offers the two scopes. The refusal message says
  "requires one of" when a tool lists more than one scope.
- **`exitReportSchema`** is strict, with no `partial` and no `default`: `facts_recorded` lost
  its default, and `tests_executed[].evidence_ref` is now `tests_executed[].evidence_id` — the
  name the plan (§8.1) and the acceptance criteria use. The service still accepts
  `task_id`/`evidence_ref` as aliases, so a caller that read either spelling is not broken.
- **`exec_ledger_status`** gained a `drift` field (and a matching line in `reasons_not_ready`).
- **C.9b gate drift:** the gate loader's empty-stamp sentinel has a null `stamp_id`; it now maps
  to “no stamp” rather than “a stamp that did not pass,” matching the status projection and
  reporting `drift: gate stamp missing` consistently.
- **Fact-promotion audit:** the human promotion route now writes the fact's UUID to `audit_events`
  (the audit table's UUID resource key), not its human-readable `F-…` ledger code. The selected
  integration suite covers both the route and the CLI path.

### Notes

- **Historical D-050 implementation note (superseded by PE-8):** the interim PE-5 Rule 11/12
  checks used report `changed_files` and `tests_executed` claims. Those fields are now descriptive
  only: Rule 11 uses server-measured scope and Rule 12 uses exact-SHA CI evidence. See
  `docs/PROGRESS.md` for current verification status.
- **Local verification (authorized, 2026-10-18):** the selected PostgreSQL-backed exec suite
  passed **84/84 tests across six files** after repairing stale fixtures and fixing the no-stamp
  drift projection and fact-promotion audit UUID. Root lint, typecheck, 371 unit tests, and build
  also passed. A full integration attempt with `FORGEPM_TEST_NO_REDIS=1` reported **254 passed,
  5 failed, 2 skipped**: four queue tests cannot enqueue without Redis, one backup endpoint needs
  PostgreSQL client utilities, and the `phase7-backup` suite could not set up without `psql` (its two
  cases were skipped). E2E/performance checks remain unrun. No push, GitHub CI, or merge occurred.
  `docs/PROGRESS.md` carries the exact scope and D.3 status.

## [Unreleased] — Execution control, PE-1 (2026-10-18)

Open-item ledger: the only supported write path, the shared status projection, and the
first real Postgres run of the phase's gates. No route, no tool, no panel change, and
**no new migration** (D-047): the "no delete path" and "closure note" laws were already
`CHECK`s in `0010`.

### Added

- **`@forgepm/core/src/exec/open-items-service.ts`** — `parseOpenItemCreate` /

  `parseOpenItemResolve` (`safeParse` → structured `VALIDATION_ERROR` with `needed_action`,
  never a throw: A.5), `findTaskByRef` by id **or** `T-NNN` code, `createOpenItem` (defaults
  from the shared `BLOCKING_BY_DEFAULT`, dedup on the C.4 key → `CONFLICT` naming the existing
  code, `allocateLedgerCode(..., 'OI')`, one `open_item.created` event with `before: null`),
  `resolveOpenItem` (refusal **before** the write for soft closures by an agent on a blocking
  item — A.3 — then one event with `before`/`after` — A.4) and `listTaskItems` (active first,
  the order the panel and the tools will share). Unknown `task_ref` → `NOT_FOUND`, never an
  orphan row (A.8).

- **`@forgepm/core/src/exec/ledger-view.ts`** — `buildLedgerStatus`, the pure projection of
  "what blocks submission": open blockers with a `needed_action` naming who must close them,
  criteria without passing evidence, unanswered blocking questions, required decisions, and
  unmet `verify_criterion` exits — deterministically sorted by code. PE-2's status tool and
  PE-12's panel render this, so there is exactly one notion of "ready".
- **`tests/unit/exec-no-delete.test.ts`** — A.2 as a gate, not a promise: no `DELETE FROM
exec_*`, no write-through UPDATE of `exec_events`/`exec_evidence`/`exec_gate_checks`, no
  route path containing `/exec`, with a positive control proving the patterns bite, and an
  assertion that every gesture appends exactly one event and touches only `exec_open_items`.

### Fixed

- **The integration harness needed a database client that exists** (D-048):
  `tests/integration/harness.ts` shelled out to `psql`, which is not shipped by
  `@embedded-postgres` (server binaries only) — so the whole `--project integration` suite was
  unrunnable wherever Postgres came from the repo's own tooling. DDL now goes through `pg`
  (`DROP DATABASE … WITH (FORCE)` also removes the race with draining pool sockets), and
  `apps/web/scripts/dev-postgres.mjs` initialises only when the data directory is fresh, so
  one cluster serves e2e and integration runs. `apps/web/e2e.sh` had the same dependency at
  its very first step (`psql` to recreate `forgepm_e2e`), so the scripted gate could not start
  on a bare clone; it now calls `apps/web/scripts/e2e-db.mjs` (`pg`, `DROP … WITH (FORCE)`,
  refused for a suspicious DB name), and the gate is green in-sandbox: `chain.spec` +
  `flagship.spec` 3/3, `visual.spec`'s 14 opt-in skips (`VISUAL=1`) unchanged.
- **A red panel gate now says why (B-012):** the CI step tees `apps/web/e2e.sh` into a file and, on
  failure, emits the run/api/dev-server log tails as an annotation. Raw Actions logs redirect to a
  blob host outside this sandbox's allowlist, so "exit code 1" used to be all a failing step said —
  which is how a 52-second red on the first PE-1 run stayed undiagnosed instead of being measured.

### Gate (honest reporting)

- `local:` build + `tsc --noEmit`: pass · lint: pass · `test:unit`: **268/268** · core exec unit:
  142/142 · `--project integration` on real Postgres: **21/21** for the ledger file (13 PE-0 +
  8 PE-1) and 189/196 for the whole suite, the 5 failures and 2 skips all Redis- or
  `pg_dump`-bound (B-005, `FORGEPM_TEST_NO_REDIS=1`) · `docs:check`: pass.
- Panel component gates (`test:web`, `contrast:check`, `raw-value:check`, `ng build`): `not-run` —
  no panel component file is in this change (they were green at the PE-0 close-out commit). The
  scripted E2E gate was run instead, because this change modifies the script itself: green here for
  the first time (chain + flagship 3/3, visual's 14 opt-in skips by `VISUAL=1`).
- `remote:` **pass** — run 39082268502 on the PR head `236af36`, 22/22 steps green (also green on
  the substantive head `5915afc`, run 39081071740). Three of the five runs on this PR were red at
  two different steps **on identical code**; none was reproduced and none was explained (B-013), so
  the panel step and the verify step now report their own failing tests as annotations. Treat
  `remote: pass` as "a full green run exists for this tree", and two reds on one sha as a defect.
- Acceptance §6: A.2/A.3/A.4/A.5/A.6/A.7/A.8 ticked with evidence; A.1 is `[~]` (projection done
  and proven from DB rows; the tool and its session-reset test are PE-2's); A.9 moves to PE-12
  because no exec panel page renders those labels yet (D-047).

## [Unreleased] — Execution control, PE-2 (2026-10-18)

The five mandatory ledger tools, on the real dispatch path: scope checks, call logging,
idempotency and the approval gate are the api's business, every ledger rule stays in
`@forgepm/core/src/exec`, and no rule got a second owner.

### Added

- **Five MCP tools** (`apps/api/src/modules/exec/mcp-tools.ts`, all gated on `module: 'exec'`):
  `exec_task_start` (work item + `exec_tasks` + one `exec_criteria` per criterion + audit + event in
  one transaction), `ledger_add_open_item`, `ledger_resolve_item` (agent soft-closure of a blocking
  item refused with `LEDGER_TRANSITION_NOT_ALLOWED`; a human's is written and logged),
  `ledger_list_open` (active first, history after), `exec_ledger_status` (the shared projection; an
  empty project answers `{empty:true, needed_action}` and names `exec_task_start`).
- **`packages/core/src/exec/task-start.ts`** — `parseTaskStart` for shape, `checkCriteria` for the
  law: a criterion must be observable and referenced, and every refusal in a batch is reported at
  once, with the shared good/bad examples. Vague wording is refused before the approval gate opens,
  so an unexecutable payload never costs a human an approval request.
- **`packages/core/src/exec/ledger-status.ts`** — `loadLedgerStatus`, the loader PE-2's tool and the
  panel both read from: six queries for a whole task set, `NOT_FOUND` for an unknown ref.
- **`apps/api/src/modules/mcp/json-schema.ts`** — `tools/list` now advertises the enforced shape
  (types, bounds, enums, uuid format, array limits) and `additionalProperties: false` only where the
  schema is a `strictObject`. Previously every tool was advertised as permissive while the handler
  rejected unknown keys (D-049).

### Fixed

- **A `text` ref compared against a `uuid` column** surfaced as `INTERNAL` rather than `NOT_FOUND`
  on the project/task lookups the tools share; the queries now cast the id side, which is also what
  lets a PRJ-key or a `T-NNN` code be passed anywhere a ref is accepted.
- **Defaulted tool fields were advertised as required** (`ZodDefault` was not treated as optional),
  so a client following the advertisement would have sent keys it could have omitted.
- **`apps/web/e2e.sh` could not run its own specs in a fresh container**: with an extracted
  `@sparticuz/chromium` binary the browser died at `eglInitialize SwANGLE failed … EGL_NOT_INITIALIZED`,
  and after the first fix it survived exactly one launch, so every spec after the first failed on
  "browser has been closed" — which is why D-046 had settled for one spec per invocation. The script
  now derives the launch flags itself when `CHROMIUM_PATH` is set and the caller passed no
  `CHROMIUM_ARGS`: drop `--single-process`/`--no-zygote` (the one-launch limit) and the ANGLE/SwANGLE
  GL flags in favour of `--disable-gpu --disable-software-rasterizer --disable-gpu-compositing`. A
  caller-supplied `CHROMIUM_ARGS` still wins, so a machine with a GPU changes nothing.

### Gate (honest reporting)

- `local:` unit **297/297** · exec integration **21/21** and tools integration **12/12** on real
  PostgreSQL 18 (the 12th case is `req_ids` declaring a requirement without ever covering it, D-049
  #2) · whole integration suite 202/5/2 (Redis and `pg_dump` bounds, unchanged) · lint ·
  typecheck · build · docs:check · `gen:api:check` (the committed OpenAPI spec and generated client
  are still up to date — PE-2 adds no REST route) : all pass.
- `local (panel):` **ran here, and passed** — `bash apps/web/e2e.sh` exits 0 against a real API on
  :3101, the dev-server on :4200 and Postgres: `chain.spec.ts` **2/2** (the §11 full chain including
  the board drag, then fa/RTL + axe with no serious/critical violation on six pages) and
  `flagship.spec.ts` **1/1**; `visual.spec.ts`'s 14 cases stay opt-in skips, which is what the plan
  prescribes (baselines are a human concern). Running it needed one harness fix, described next; no
  panel _application_ file is in this change.
- `local (coverage):` the CI threshold run cannot be reproduced while the Redis-bound files fail
  (vitest suppresses the report on failure); per-file slices — `task-start.ts` 86.4% lines via
  integration and 38.8% via unit, `ledger-status.ts` 84.6%, `apps/api/src/modules/exec` 82.87%,
  `json-schema.ts` 96.6% — clear the 80% floor on the union, with the residual risk in branch detail.
- `remote:` **pass** — PR #13, run 39120040693: 22/22 steps green, from a fresh session, because the
  branch PE-2 was committed on (`arena/c216c536-forgepm`) was closed to GitHub operations once its PR
  was merged. CI has now seen the tree, including the coverage-threshold run that the local half
  could not reproduce while the Redis-bound files failed.
- Acceptance §7: B.1–B.8 ticked with their tests; §6 A.1 closed here (the tool over real rows plus the
  empty-project case).

## [Unreleased] — Execution control, PE-2 (2026-10-18)

The five mandatory ledger tools, on the real dispatch path: scope checks, call logging,
idempotency and the approval gate are the api's business, every ledger rule stays in
`@forgepm/core/src/exec`, and no rule got a second owner.

### Added

- **Five MCP tools** (`apps/api/src/modules/exec/mcp-tools.ts`, all gated on `module: 'exec'`):
  `exec_task_start` (work item + `exec_tasks` + one `exec_criteria` per criterion + audit + event in
  one transaction), `ledger_add_open_item`, `ledger_resolve_item` (agent soft-closure of a blocking
  item refused with `LEDGER_TRANSITION_NOT_ALLOWED`; a human's is written and logged),
  `ledger_list_open` (active first, history after), `exec_ledger_status` (the shared projection; an
  empty project answers `{empty:true, needed_action}` and names `exec_task_start`).
- **`packages/core/src/exec/task-start.ts`** — `parseTaskStart` for shape, `checkCriteria` for the
  law: a criterion must be observable and referenced, and every refusal in a batch is reported at
  once, with the shared good/bad examples. Vague wording is refused before the approval gate opens,
  so an unexecutable payload never costs a human an approval request.
- **`packages/core/src/exec/ledger-status.ts`** — `loadLedgerStatus`, the loader PE-2's tool and the
  panel both read from: six queries for a whole task set, `NOT_FOUND` for an unknown ref.
- **`apps/api/src/modules/mcp/json-schema.ts`** — `tools/list` now advertises the enforced shape
  (types, bounds, enums, uuid format, array limits) and `additionalProperties: false` only where the
  schema is a `strictObject`. Previously every tool was advertised as permissive while the handler
  rejected unknown keys (D-049).

### Fixed

- **A `text` ref compared against a `uuid` column** surfaced as `INTERNAL` rather than `NOT_FOUND`
  on the project/task lookups the tools share; the queries now cast the id side, which is also what
  lets a PRJ-key or a `T-NNN` code be passed anywhere a ref is accepted.
- **Defaulted tool fields were advertised as required** (`ZodDefault` was not treated as optional),
  so a client following the advertisement would have sent keys it could have omitted.
- **`apps/web/e2e.sh` could not run its own specs in a fresh container**: with an extracted
  `@sparticuz/chromium` binary the browser died at `eglInitialize SwANGLE failed … EGL_NOT_INITIALIZED`,
  and after the first fix it survived exactly one launch, so every spec after the first failed on
  "browser has been closed" — which is why D-046 had settled for one spec per invocation. The script
  now derives the launch flags itself when `CHROMIUM_PATH` is set and the caller passed no
  `CHROMIUM_ARGS`: drop `--single-process`/`--no-zygote` (the one-launch limit) and the ANGLE/SwANGLE
  GL flags in favour of `--disable-gpu --disable-software-rasterizer --disable-gpu-compositing`. A
  caller-supplied `CHROMIUM_ARGS` still wins, so a machine with a GPU changes nothing.

### Gate (honest reporting)

- `local:` unit **297/297** · exec integration **21/21** and tools integration **12/12** on real
  PostgreSQL 18 (the 12th case is `req_ids` declaring a requirement without ever covering it, D-049
  #2) · whole integration suite 202/5/2 (Redis and `pg_dump` bounds, unchanged) · lint ·
  typecheck · build · docs:check · `gen:api:check` (the committed OpenAPI spec and generated client
  are still up to date — PE-2 adds no REST route) : all pass.
- `local (panel):` **ran here, and passed** — `bash apps/web/e2e.sh` exits 0 against a real API on
  :3101, the dev-server on :4200 and Postgres: `chain.spec.ts` **2/2** (the §11 full chain including
  the board drag, then fa/RTL + axe with no serious/critical violation on six pages) and
  `flagship.spec.ts` **1/1**; `visual.spec.ts`'s 14 cases stay opt-in skips, which is what the plan
  prescribes (baselines are a human concern). Running it needed one harness fix, described next; no
  panel _application_ file is in this change.
- `local (coverage):` the CI threshold run cannot be reproduced while the Redis-bound files fail
  (vitest suppresses the report on failure); per-file slices — `task-start.ts` 86.4% lines via
  integration and 38.8% via unit, `ledger-status.ts` 84.6%, `apps/api/src/modules/exec` 82.87%,
  `json-schema.ts` 96.6% — clear the 80% floor on the union, with the residual risk in branch detail.
- `remote:` **pass** — PR #13, run 39120040693: 22/22 steps green, from a fresh session, because the
  branch PE-2 was committed on (`arena/c216c536-forgepm`) was closed to GitHub operations once its PR
  was merged. CI has now seen the tree, including the coverage-threshold run that the local half
  could not reproduce while the Redis-bound files failed.
- Acceptance §7: B.1–B.8 ticked with their tests; §6 A.1 closed here (the tool over real rows plus the
  empty-project case).

## [Unreleased] — Execution control, PE-0 (2026-10-17)

Scaffolding phase of `docs/EXECUTION_CONTROL_PLAN.md` (agent execution control:
persistent ledger + deterministic Finalization Gate). No behaviour changes: the
`exec` module is registered and OFF, so `tools/list`, `/health/ready` and every
existing route are untouched.

### Added

- **Migration `0010_exec`** — the 17-table ledger (`exec_requirements`,
  `exec_req_tasks`, `exec_tasks`, `exec_task_deps`, `exec_criteria`,
  `exec_evidence`, `exec_open_items`, `exec_decisions`, `exec_questions`,
  `exec_reviews`, `exec_reports`, `exec_gate_checks`, `exec_facts`,
  `exec_fact_decisions`, `exec_baseline_tests`, `exec_action_journal`,
  `exec_events`) plus `exec_code_seq`, `work_items.exec_task_id`, the
  `exec_append_only()` trigger on the audit surfaces, `exec_journal_settle_only()`
  (a journal row may be settled exactly once, its claim columns are immutable) and
  a `REVOKE` block that applies when a dedicated app role exists. The block is the
  contract copy in `docs/DATA_MODEL.md` §H (verified column/index parity offline).
- **`@forgepm/shared/schemas-exec.ts`** — every ledger input (task/criterion/
  open-item/evidence/decision/question/requirement/fact/journal/block), the exit
  report with the "explicit none" rule as a pure checker (`checkNoneConfirmed`),
  the risk-policy + harness documents, `parseTestLog`, `assessCheckable` (a vague
  criterion is rejected with a fix hint) and `detectWeakening`.
- **`@forgepm/core/src/exec/*`** — the deterministic half of the system: 13-rule
  `evaluateGate` (+ `deriveStatusAfterFailure`, `buildFinalReport`), risk
  `classify` with hard denials an admin cannot downgrade, open-item state machine,
  evidence verification (ref grammar, allowed roots, payload minimums, secret
  redaction), scope measurement, baseline comparison, journal write-lock, session
  packing, adversarial-reviewer input assembly (conversation keys are refused) and
  its strict output parser, ledger code allocation.
- **16 `exec.*` settings** (`exec.policy`, `exec.test_command`,
  `exec.test_result_parser`, `exec.protected_test_globs`, `exec.allowed_repo_roots`,
  `exec.baseline_source`, `exec.ci_log_endpoint`, `exec.ci_log_secret_name`,
  size/output caps, review rounds, gate/transition switches) in category
  `execution`; defaults validate against their own schemas, and the key list
  itself is asserted so adding one is a reviewed change (D-041 removed the five
  `exec.runner*` keys: ForgePM never executes repo code, so `exec_baseline_tests`
  is fed only by the CI log — `source IN ('ci','human')` — and rule 12 fails
  closed with `BASELINE_UNAVAILABLE` until a human waives).
- **`exec` module** (`apps/api/src/modules/exec/module.ts`) registered in
  `app/modules.ts` with `validateConfig` that refuses to enable the module while
  `exec.*` documents do not parse. Scopes `ledger:read` / `ledger:write` /
  `ledger:decide` (human-only) added to `API_KEY_SCOPES` + `docs/MCP_CONTRACTS.md`.
- **Tests**: 101 new DB-free unit tests (`packages/core/src/exec/*.test.ts`) plus a
  4-test structural guard (`tests/unit/exec-no-spawn.test.ts`, mutation-checked)
  covering each acceptance rule by number (F.1–F.8, C.1–C.12, B.6, B.10, J.2–J.6,
  K.1–K.4, E.1–E.4); `tests/integration/exec-ledger-invariants.test.ts` covers the
  DB-side invariants, 20-way concurrent code allocation and module-off gating.

### Fixed

- **Two inherited §11 panel E2E failures** (both blocked every branch's remote gate):
  the info badge's contrast on its own tint, and the board drag never reaching a move.
  Light-theme `--color-ok`/`--color-warning`/`--color-info` are darkened so the 12%/14%
  tinted badge/chip surfaces clear 4.5:1, and `npm run check:contrast` now derives those
  tint pairs from `styles.scss` itself — 52 pairs checked, D-044.
- **Board drag: engine-independent gesture + the §11 E2E race that hid it** (D-046,
  B-011, issue #11). `chain.spec.ts`'s `dragTo` released at a tall column's centre, so
  Playwright scrolled the page with the mouse already down and the drop moved a
  _different_ card than the key the spec had read (app moved `EPRJ-3`, spec polled
  `EPRJ-5`); the release point is now pinned and the spec asserts the card under the
  pointer still carries that key. The board no longer depends on the browser opening an
  HTML5 drag session: `apps/web/src/app/ui/board-drag.ts` runs a pointer session (pure
  reducer in `ui/logic.ts`: press → 4px threshold → release over a foreign column) with
  HTML5 DnD as the enhancement and a per-press token so one gesture can never apply
  twice; touch and `dataTransfer` behaviour are unchanged. 14 new tests in
  `ui/board-drag.spec.ts`, and `ng test --configuration=coverage` was added to the CI
  panel step so the panel's unit tests and ≥80% coverage thresholds are gated remotely.
  `chain.spec.ts` now passes locally against a real chromium (both drag paths exercised).
  An earlier entry here credited D-045's `dataTransfer` fallback with fixing this; that
  hypothesis was wrong and the fallback was reverted in `45a491a`.

- **`apps/web/scripts/e2e-reset.mjs` was not portable** (found while getting PE-0's
  remote gate to run): it resolved `pg` via a hardcoded absolute workspace path, so
  `bash apps/web/e2e.sh` — and therefore the CI step "Panel build + Playwright
  flagship E2E" — failed on every machine except the one that wrote it. Now anchored
  to the script's own location. This was inherited from `main` (PR #8 merged while
  Actions could not start), proven by a zero-change probe of `main`'s tip; see
  docs/BLOCKERS.md B-010.
- `apps/api/openapi.json` + `apps/web/src/api/schema.d.ts` were stale on `main`
  (missing `GET /api/v1/work-items/:key/relations` and
  `POST /api/v1/ai-providers/models` from PR #8), which failed `npm run
gen:api:check` on `main` itself — proven by the same probe. Regenerated here.

### Gate (honest reporting)

- `local:` lint ✅ · typecheck (all workspaces) ✅ · `test:unit` ✅ 221/221 ·
  `build` ✅ · `docs:check` ✅ · migration-hash manifest ✅ (9 migrations).
- `local:` against a real PostgreSQL, booted without Docker via the repo's own
  `apps/web/scripts/dev-postgres.mjs` (D-042): `npm run migrate` on an empty DB ✅
  and idempotent on rerun ✅ · `npm run schema:check` ✅ "60 contract tables
  verified" · `tests/integration/exec-ledger-invariants.test.ts` ✅ 13/13 ·
  `npm run test:integration` with `FORGEPM_TEST_NO_REDIS=1` → 183/190, the 7
  failures confined to pre-existing Redis-bound (`outbox`, `phase5-worker`) and
  `pg_dump`-bound (`phase7-*`) suites. Running them found three real bugs, fixed
  here: the gate crashed on an empty exit report, `extractCounts` misread CI
  summary lines, and a root-level `**/*.test.ts` glob failed to match.
- `local not-run:` coverage ≥80 on `exec/**`; the queue-based suites (no Redis in
  this sandbox).
- `remote:` **cannot-run** — PR #9's CI job never started ("recent account
  payments have failed or your spending limit needs to be increased"), so there
  is no hosted runner to prove the CI-side gates. PE-0 is therefore _not_ closed:
  fix Actions billing, attach a self-hosted runner (Postgres + Redis), or record
  an explicit human waiver in the ledger (docs/BLOCKERS.md B-009).

## [1.0.0-rc.1] — Release candidate (2026-10-10)

Phases 0–7 are complete and every acceptance gate has run green (local +
remote CI on the pushed commits — see docs/FINAL_REPORT.md). This rc bumps all
workspace versions and the OpenAPI document to `1.0.0-rc.1`. Intentionally not
in v1 (plan §17 "فهرست عمداً حذف‌شده"): automated code-change execution,
multiple autonomous agents, full two-way GitHub sync, enterprise org reporting,
microservices/multi-region, a general workflow engine, Cycle/Sprint, email and
billing. Open deviations are recorded honestly in docs/BLOCKERS.md (B-006
optional MCP client 4b; B-008 octokit diff/comment adapters) with the mandatory
core (4a MCP server, GitHub webhook→outbox→worker proven end to end) shipped.

## [0.7.0] — Phase 7 (2026-10-10, panel-completion increment)

### Added

- **System panel REST surface.** `GET /api/v1/jobs`, `POST /api/v1/jobs/:id/retry`
  (DB-only re-queue; the worker sweeper re-enqueues per §3b-3), `GET
/api/v1/system/health` (db/redis/module flags), `POST /api/v1/system/backup`
  (admin, runs `scripts/backup.sh` + audits) and `GET /api/v1/mcp/calls` (§8.11
  masked tool-call log) — the endpoints `docs/API_CONTRACTS.md` promised and the
  backend-first phases left for the panel.
- **All remaining §11 panel pages** as thin clients over the tested REST surface
  (lazy routes, standalone + signals, OnPush): Work Items List+Board (HTML5 drag
  → server transitions), item detail (comments/activity/transition), Features +
  Milestones (dual `work_progress`/`release_readiness`), Planner (create →
  generate with the `fake` provider → approve → apply, separate actions),
  Approvals queue, Reviews (runs/findings/dismiss/accept/create-issue;
  guidance-only while modules are off), AI Providers, GitHub config + repo
  linking, MCP call log, full Settings inheritance matrix (override / back-to-
  inherited / source badges), System health + jobs + module toggles + backup,
  Users + Audit.
- **Panel i18n + RTL.** Bilingual `en`/`fa` dictionaries with a signal-driven
  `lang`/`dir` switch and `apps/web/scripts/i18n-check.mjs` (CI key-parity gate,
  120 keys). Hand-rolled rather than ngx-translate for the bundle budget (D-034).
- **Accessibility + layout.** axe sweep (no serious/critical violations), fa/RTL
  assertion and 360/1280 px no-horizontal-overflow checks in the flagship chain
  spec; light/dark, logical-property responsive stylesheet.
- **Performance tooling.** `pnpm seed:perf` (PERFORMANCE_BUDGET dataset: 10k
  projects, a 200k-item project + 300k background items, ANALYZE, seeded login
  - API key), `pnpm perf` (P-01..P-03 via autocannon, 20 conns / 30s warm-up /
    60s measure / p95 thresholds; p99 stand-in per D-035) and the P-05 first-paint
    Playwright gate (`apps/web/e2e-perf.sh`).
- **Migration `0009_perf`** (forward-only, contract-synced): partial
  `(project_id|organization_id, created_at DESC, id DESC) WHERE deleted_at IS
NULL` cursor indexes the §12 contract requires. The load run found P-02
  scanning ~310k rows (p95 ~6s); these bring it to ~70ms (D-036).

### Fixed

- Dev-server proxy contexts narrowed `/api` → `/api/v1` (+ `/mcp`) so the
  `/api-keys` SPA route is no longer swallowed by the Angular dev-server proxy.
- `fake` `ai_providers` rows now generate a deterministic plan offline (was an
  inert empty response), powering the §11 "plan with the fake provider" step.
- `e2e.sh` runs each spec against a per-file DB reset so every flow starts on a
  brand-new install (the §11 chain begins at first-run setup).

### Tests / gates

- 7 red-first integration tests for the System surface (jobs pagination +
  `jobs:read` matrix + cross-org 404, retry re-queue + 409, health flags,
  audited backup, MCP call log). Full backend suite 39 files / 269 tests green;
  `pnpm verify`, `gen:api:check`, `schema:check`, `docs:check`, migration-hash
  guard and `pnpm perf` green; flagship E2E + §11 chain + P-05 green locally.

## [0.7.0-rc] — Phase 7 flagship subset (2026-10-09)

### Added

- **Angular panel (apps/web) — flagship path shipped.** Standalone + Signals,
  lazy routes, OnPush, i18n-free bilingual shell with a data-testid contract.
  Pages: `/auth` (first-run Setup + Login), `/projects` (list + create +
  archive), `/api-keys` (list + create with raw-key-shown-exactly-once +
  revoke). Session/CSRF handled by `ApiClient` (reads `fpm_csrf` cookie and
  echoes it as `x-csrf-token` on every mutating request).
- **OpenAPI-generated client (`pnpm gen:api`).** `scripts/gen-api.ts` boots the
  Fastify app in-process, dumps `apps/api/openapi.json` (74 paths) and pipes it
  through `openapi-typescript` (pinned `7.13.0`) to
  `apps/web/src/api/schema.d.ts`. `pnpm gen:api:check` fails on any drift;
  wired into CI.
- **Reproducible E2E (`pnpm test:e2e`).** `apps/web/e2e.sh` resets a throwaway
  DB, builds the backend, starts Fastify on :3101, runs the Angular dev-server
  on :4200 via a proxy (`proxy.e2e.json`), and drives Chromium through the
  flagship flow (Setup → project → API key with raw-once assertion → logout →
  login) — passing locally. CI runs `playwright install --with-deps chromium`
  and executes the same script.
- **`GET /metrics` (plan §14 observability)** behind `METRICS_ENABLED`, using a
  dependency-free Prometheus registry in `packages/core/src/metrics.ts`.
  Exposes `http_requests_total{method,route,status}` (bounded cardinality),
  `http_request_duration_seconds` histogram, `forgepm_queue_length` +
  `forgepm_jobs_failed` gauges (derived live from `jobs`),
  `forgepm_ai_calls_total{purpose,status}` and
  `forgepm_mcp_tool_calls_total{tool,outcome}` counters incremented at their
  respective `ai_calls`/`mcp_tool_calls` insert points.
- **Nightly retention job (plan §14 scalability).** `runRetention` in core
  prunes `audit_events`, `mcp_tool_calls`, `ai_calls` and
  `webhook_deliveries` per each org's effective `retention.*_days` (system and
  org scopes honoured, tenancy-safe). `apps/worker/src/retention-job.ts` wires
  it into the worker bootstrap with a `system.retention` `audit_event` per
  pruned (org, table).
- **Key rotation (`scripts/rotate-secret.ts`, plan §14 / RUNBOOK).**
  `rotateDbSecrets(db, oldKey, newKey, newVersion)` re-encrypts every
  `secrets.ciphertext` and `ai_providers.encrypted_key` blob, tagging rows with
  the new `key_version`. Idempotent (already-current blobs are skipped).
- **EXPLAIN hot-query guard (PERFORMANCE_BUDGET P-04).**
  `tests/integration/phase7-explain.test.ts` runs 11 hot query shapes through
  `EXPLAIN` with `enable_seqscan = off` and asserts no `Seq Scan on <guarded>`
  appears — proving every named index exists and is usable by the planner.
  Guard verified non-vacuous (dropping an index makes the test fail).

### Fixed

- `scripts/backup.sh` exited 2 whenever no storage tarballs existed (the `ls`
  glob failed under `set -e -o pipefail`). Rewritten with a `prune()` helper
  that treats an empty glob as success. New
  `tests/integration/phase7-backup.test.ts` does a real
  backup → fresh empty DB → restore round-trip with row counts + checksum over
  200 seeded rows and also asserts `restore.sh` refuses a non-empty target.

### Notes

- `apps/web` is intentionally a **standalone pnpm workspace** (D-031): Angular
  22 pins TS 6.x, the backend pins 5.7.2. It is excluded from root
  `eslint`/`pnpm -r build`/`pnpm verify` and gated by its own build + E2E.
- Remaining §11 acceptance items (Board/Planner/MCP/GitHub/Reviews/Settings
  pages, i18n key parity, axe a11y sweep, 200k-item first-paint, full 9-step
  E2E chain, compose-backed E2E) remain **OPEN** in `BLOCKERS.md` (B-005,
  reduced). The backend surface for each is already covered by integration
  tests; the missing work is the thin panel client + gate.

## [0.6.0] — Phase 6 (2026-10-09)

### Added

- Migration `0008_reviews` implementing Schema Contract §G verbatim:
  `review_runs` (kind `code|refactor`, target/status CHECKs, composite FK to
  projects, `runs_project_created_idx`), `review_findings`
  (`UNIQUE(project_id, scope_key, fingerprint)`, severity + status CHECKs,
  full finding structure incl. impact/effort/risk) and
  `code_structure_index` (`UNIQUE(repository_id, commit_sha)`). Two additive
  helper columns documented in §G: `review_findings.unseen_streak` and
  `review_runs.input` (D-027).
- Shared review engine in **core** (`packages/core/src/review/*`, D-025):
  contracts (fingerprint = sha256(project|category|file|normalized title|
  hash(normalized evidence)) — line-independent; scope keys `pr:<repo>:<n>` /
  `repo:<repo>`; glob matcher), evidence validation against the run's commit
  snapshot (+ diff-hunk containment for code findings; ≤20-line evidence;
  `min_confidence` floor; invalid → `run.stats.discarded`), finding upsert
  (rerun touches `last_seen_run_id` instead of duplicating; DB UNIQUE enforced),
  `not_seen` → `fixed` lifecycle that only counts COMPLETE runs (streak ≥ 2),
  the shared issue policy (record_only / human_approval via approval_requests /
  auto_high_severity with kind floors 0.8/0.85, cap 10/run, idempotent per
  finding_id; created items typed bug|refactor, source code_review|refactor_review,
  `agent-ready` label + acceptance criteria), effective config resolver
  (project ← organization ← system ← registry default) and the GitHub output
  slot (`off` ⇒ zero write calls; one `<!-- forgepm:review -->` comment
  updated in place; D-030).
- Deterministic Repository Analyzer (no AI, plan §10.6.2): file/language/LOC
  counts, TS/JS function metrics (length, cyclomatic complexity, params),
  rolling-hash duplicate blocks (≥6 lines / 50-token rule), import graph with
  cycle + fan-in/out detection, compact `code_structure_index` JSON per commit;
  partitioned staged analysis (§10.6.4, cursor on run stats, D-029) and
  incremental scope = changed files + direct neighbours (§10.6.5).
- Review code sources (§10.6.1): `local` read-only mount under
  `REPO_MOUNT_ROOT` guarded against traversal, `github` fetch through an
  injected fetcher staged into a temp worker dir that is ALWAYS removed —
  success or failure (`withStagedRepo`).
- `code_review` + `refactor_review` modules registered always, default OFF
  (`modules.<name>.enabled`), enabled/disabled at runtime without restart.
- Settings registry: `review.max_attempts`, `review.max_cost_tokens`,
  `review.github_output`, `review.ignore_globs`, `code_review.{max_diff_bytes
(200 KB default), skip_drafts, custom_rules}`,
  `refactor_review.{min_severity, max_files_per_run (5000), categories}`.
  Redeclaring a shared `review.*` key under a module prefix is rejected with
  **422** (§10; `isReviewKeyRedeclaration`).
- REST (`apps/api/src/modules/reviews/*`), every endpoint module-gated 503:
  `GET /api/v1/review/runs` + `/runs/:id` + `/runs/:id/cancel`,
  `POST /review/code-runs`, `POST /review/refactor-runs`,
  `GET /review/findings` (cursor-paginated, severity/status/kind filters),
  `POST /review/findings/:id/decision`,
  `POST /review/findings/:id/create-work-item` (202 pending_approval under
  human_approval). New matrix actions `review:run` / `review:decide`.
- MCP: the eight §13 tools `review_start_code_review`, `review_get_report`,
  `review_list_findings`, `review_update_finding`,
  `review_create_work_item_from_finding`, `refactor_review_start`,
  `refactor_review_get_report`, `refactor_review_list_findings` — scope
  `review`, gated on either review module (hidden from `tools/list` AND
  rejected at call time when both are off; `McpToolDefinition.module` now
  accepts an any-of array).
- Worker: PR deliveries with action `opened|synchronize|ready_for_review`
  enqueue `review.code_run` outbox jobs only when the project has
  `code_review` enabled + `review.auto_run`; the handler runs the SAME core
  engine as REST (runtime re-check of gates), system actor, one job per
  connected project. `StubProvider` + provider/diff/output slots keep the
  whole suite offline (D-026).

### Tests

- 22 core unit cases: fingerprint/normalization/globs, evidence validation
  (bad file/range/mismatch/out-of-hunk/long evidence), partition counts,
  issue-policy eligibility floors, analyzer (long fn / duplication / cycle /
  languages), partitioning (12 000 → 3×5 000 deterministic), import resolver.
- 5 sources unit cases: temp-clone removal on success AND failure, mount-root
  traversal guard, fetcher slot, incremental scope.
- 17 phase-6 integration cases: both modules off ⇒ 503 + no MCP tools + no
  auto jobs; enable without restart; fake-provider run completes with the full
  required finding shape; discarded counter; rerun dedupe + `last_seen_run_id`
  - line-shift ≠ duplicate; DB UNIQUE enforced; not_seen(1) → fixed(2) with a
    truncated run NOT counting; truncation + ignore globs never reach the
    provider; record_only / human_approval (queue once, approve, create exactly
    one, idempotent replay) / auto_high_severity (floors + cap 10); 422 on
    redeclaration; github_output summary (one comment, updated) and off (zero
    calls); MCP tools/list + tools/call through an agent key; cancel; audit on
    every mutation.
- 5 phase-6 worker cases: module off ⇒ no enqueue; auto_run off ⇒ no enqueue;
  module+auto on ⇒ exactly one outbox job; handler runs the shared engine
  offline; gate re-check at run time skips without a run row.
- Refactor cases: analyzer-without-AI (long fn ≥110 lines/complexity, dup pair,
  import cycle stored), finding shape incl. impact/effort/risk, partitioned
  12 000-file coverage [1,2,0], incremental rerun sends only changed file +
  neighbours, 503 when the module is off.
- Suite: **227 tests** (54 new: 22 core-review unit + 5 sources unit + 17
  phase-6 + 5 phase-6-worker + 5 refactor); `pnpm verify` green;
  `schema:check` 43 tables; migration hash manifest updated for `0008_reviews`.

### Known gaps (recorded)

- Panel Reviews page + Playwright E2E and the octokit-backed diff/comment
  writers ship with the phase-7 panel (B-007, B-008).

## [0.0.0] — Phase 0 (2026-10-09)

### Added

- pnpm workspace monorepo: `packages/shared` (zod contracts, enums, error
  codes, cursor pagination), `packages/core` (infrastructure), `apps/api`,
  `apps/worker`, `apps/web`, `tests`, `scripts`.
- Strict TypeScript (CommonJS backend), ESLint with module-boundary +
  raw-connection rules proven by forbidden fixtures, Prettier, commitlint,
  husky hook, `.nvmrc`, engines pinning.
- `pnpm verify` = lint → typecheck → unit+integration with coverage
  thresholds (80% lines/functions) → build.
- Env validation with Zod (`FORGEPM_SECRET_KEY` 32-byte base64 enforced),
  clear failure message + non-zero exit.
- Kysely + forward-only migrator; migration `0001_infra` implementing the
  Schema Contract §A exactly (outbox, jobs with `heartbeat_at`/`outbox_id` +
  unique `jobs(outbox_id)`, idempotency_keys with
  `UNIQUE(actor_id, operation, key)`, settings with the scope CHECK and the
  partial/expression unique equivalent of `NULLS NOT DISTINCT` — PG14-safe
  per DECISIONS D-002).
- `unitOfWork(ctx, fn)` transaction+outbox primitive; `scopedDb(ctx)` tenancy
  wrapper; application-side UUIDv7 generator.
- Module registry implementing §3b-1 lifecycle: always-registered, runtime
  `modules.<name>.enabled` (≤5s cache + invalidation), `requireModule` guard
  → `503 MODULE_DISABLED`, `validateConfig()` on enable, no-restart toggling
  (`GET /api/v1/modules`, `PUT /api/v1/modules/:name/enabled`). Sample module
  with routes registered while disabled.
- Effective settings resolution project ← organization ← system matching the
  exact `scope_id` (tenancy bug caught and fixed by the red acceptance test).
- AES-256-GCM secret cipher with `key_version` rotation layout; pino logging
  with credential redaction.
- Fastify app: unified error envelope `{ error: { code, message, details?,
request_id } }`, `request_id` on every request, security headers, CORS
  pinned to `WEB_ORIGIN`, 1 MiB body limit, `GET /health/live`,
  `GET /health/ready` (503 when Postgres _or_ Redis is down; live stays 200 —
  automated), OpenAPI 3.0 document at `/api/v1/openapi.json`.
- Worker: BullMQ outbox dispatcher (`FOR UPDATE SKIP LOCKED`, job registry
  row in one transaction, enqueue via BullMQ jobId dedupe, `dispatched_at`
  stamped after enqueue, crash between commit and enqueue recovers without
  duplicate effects) and job sweeper (stale `queued` re-enqueued, stale
  `running` heartbeat → `failed`), sample `system.ping` job executed purely
  through the outbox path with at-least-once idempotency.
- Vitest unit + integration suites (real Postgres/Redis; per-file isolated
  databases): 51 tests covering health, module lifecycle, settings
  constraints and inheritance/override, jobs CHECKs, unitOfWork rollback
  semantics, dispatcher exactly-one-effect + crash recovery, sweeper
  recovery, ESLint boundary fixtures failing as required.
- Docker: multi-stage Dockerfiles, `docker-compose.yml` (five services,
  healthchecks, persistent postgres volume) + `docker-compose.dev.yml`,
  `.env.example` with per-variable explanations.
- GitHub Actions CI (Node 22 + postgres:16/redis:7 services): lint,
  typecheck, migrate on empty DB, unit+integration+coverage, build,
  `schema:check` (incl. deliberate-diff self-test), `docs:check`,
  compose-up smoke of `/health/ready`, migration hash guard against editing
  merged migrations, `pnpm audit` failure gate.
- Docs: EXECUTION_PLAN copy + derived PRODUCT, ARCHITECTURE, DATA_MODEL
  (full schema contract), SECURITY, API_CONTRACTS, MCP_CONTRACTS, MCP client
  config, ACCEPTANCE_CRITERIA, PERFORMANCE_BUDGET, DECISIONS (D-001…D-009),
  BLOCKERS (B-001…B-004), GITHUB, REVIEWS, RUNBOOK, SCALING; AGENTS.md with
  plan §2 rules only; README quick start ≤ 5 commands.
- Scripts: `schema:check`, `docs:check`, `seed`, `smoke`, `doctor`,
  `phase-report` (emits the two-line `local:`/`remote:` report; remote CI
  status via `gh`), `backup.sh` / `restore.sh` (restore refuses a non-empty
  target; the 10k-row restore equivalence test is a Phase-7 gate),
  `publish.sh` (idempotent §16 steps 5–8), commit-message husky hook.
- Panel: Phase 0 ships a static bilingual placeholder page (fa/RTL + en) in
  `apps/web/public/`. The Angular standalone+signals project (plan §4.7) is
  delivered with its first real screens in Phase 1 — DECISIONS D-010 records
  this explicit, honest scoping; the web service is therefore not part of
  `docker compose up` yet.

### Known gaps (recorded, nothing claimed green)

- `docker compose up` not runnable inside the execution sandbox (no Docker;
  BLOCKERS B-001/B-002) — the compose path is exercised by Remote CI instead;
  local verification used native Postgres 14 + Redis.

## [0.1.0] — Phase 1 (2026-10-09)

### Added

- Migration `0002_core`: organizations, users (argon2id hash + CHECK
  locale/status), memberships, sessions (token_hash + expiry indexes), agents,
  api_keys (key_hash unique, scopes[]/project_ids[], CHECK exactly one owner),
  secrets (AES-256-GCM ciphertext + key_version + last4), projects
  (`UNIQUE(id, organization_id)` + `UNIQUE(organization_id, key)` + key CHECK
  `^[A-Z]{3,5}$` + cursor index), project_members, audit_events — DDL matches
  DATA_MODEL §B exactly and `pnpm schema:check` now verifies §A+§B (14 tables).
- Auth module: `POST /auth/login` (argon2id verify, httpOnly SameSite=Lax
  session cookie + readable CSRF cookie, per-IP+email rate limit 10/15min →
  429, 401 AUTH*INVALID_CREDENTIALS on bad password/unknown user), `POST
/auth/logout`, `GET /auth/me`, one-time `POST /auth/setup` (409 after first
  user), `GET /auth/csrf`. `bootstrapAdminFromEnv` honours FORGEPM_ADMIN*\*.
- API-key auth (`Authorization: Bearer fpm_...`) resolved alongside sessions
  into a single Actor shape (plan §1.2); raw key = `fpm_` + 40 hex, only
  SHA-256 stored, minted once, revoked/expired keys rejected at call time.
- API Keys CRUD (`GET/POST/DELETE /api-keys`) — scopes, project_ids, expiry;
  admins manage all, users their own; raw shown only at creation.
- Permissions module: pure role matrix `can()/authorize()` (org owner/admin/
  member/viewer × project lead/contributor/viewer) + `assertProjectAccess`
  returning tenancy-correct 404-vs-403 (member not in a project ⇒ 404, viewer
  creating ⇒ 403) so no cross-project existence leaks.
- Projects CRUD + archive/unarchive + soft-delete + members
  (`GET/POST/PATCH/DELETE /projects`, `/archive`, `/unarchive`, `/members`),
  every mutation in one `unitOfWork` with an `audit_event`.
- Settings: registry (`SETTING_DEFINITIONS`, schema+default+category per key +
  pattern `modules.<name>.enabled`), effective resolution project←org←system
  with source reported, PUT/DELETE per scope (system/org owner-gated, project
  settings:system/lead-gated).
- Users & memberships admin routes (create user + membership, patch, list),
  Audit read (`GET /audit` cursor-paginated, admin only).
- Fastify app: cookie + @fastify/rate-limit plugins, per-route guards, unified
  error envelope, CSRF double-submit for mutating session requests.
- Tests: 22 Phase-1 integration cases (real Postgres/Redis) + permission-matrix
  unit suite covering every role/action; login rate limit, one-time setup,
  raw-key non-persistence (DB+audit grep), expired-key rejection, viewer/member
  403/404, api-key project restriction, two-org isolation + unique(org,key),
  settings inheritance + delete-to-inherit, audit-rollback via injected
  trigger, pagination cursor + limit>200 rejection. Suite: 81 tests green;
  `pnpm verify` passes (coverage 91.6% lines).

### Known gaps (recorded, nothing claimed green)

- Panel UI not built this run (BLOCKERS B-005, deviation D-013): login/setup/
  projects/settings/api-keys/users/audit/jobs pages and Playwright E2E are
  pending; all Phase-1 behaviour is verified via REST integration tests.
- `docker compose up` compose gate for Phase 1 exercised in Remote CI only
  (B-001 unchanged).

## [0.2.0] — Phase 2 (2026-10-09)

### Added

- Migration `0003_domain`: workflow_states, milestones, features, work_items
  (composite FKs, assignee one-of CHECK, acceptance_criteria jsonb,
  search_vector generated + GIN), work_item_relations, labels,
  work_item_labels, comments, saved_views, work_item_external_links,
  feature_dependencies. DATA_MODEL §C updated with the composite
  `UNIQUE(id, organization_id)` targets required by §3b-2.
- Work items: CRUD + transition + relations + comments + external links +
  activity (from audit) + full-text search + bulk create (idempotency).
  Default workflow auto-seeded per project (Backlog/Todo/In Progress/In Review/
  Done/Canceled). Item key `PRJ-N` with atomic `UPDATE ... RETURNING` numbering
  — 50 parallel creates yield contiguous unique numbers.
- Blockers: transition to `completed` refused with 409 BLOCKED_BY_OPEN_ITEMS;
  blocking-cycle detection (2- and 3-node) returns 409 DEPENDENCY_CYCLE.
- Features: dual `work_progress` (completed/(total−canceled)) and
  `release_readiness` (ticked AC); `released` requires 100% readiness unless an
  owner overrides (override recorded in audit).
- Milestones with computed progress; Saved Views (personal/shared); Labels
  on-the-fly; Comments (user/agent author types).
- Core helpers: `idempotency` (begin/store/abandon, `UNIQUE(actor,op,key)`),
  pure `graph.ts` (findCycle, workProgress, releaseReadiness) with unit tests,
  `schemas-domain.ts` zod contracts, work-items module `index.ts` public
  surface (cross-module calls go through it, ESLint boundary intact).
- Tests: 13 Phase-2 integration cases (numbering concurrency, blockers,
  cycles, dual progress + override, bulk idempotency + body-mismatch 422,
  assignee CHECK, soft-delete/list/search/audit, activity, combined filters,
  milestones, saved views, comments) + graph unit suite. Suite: 100 tests
  green; `pnpm verify` passes.

### Known gaps (recorded)

- Panel Board/List UI + Playwright E2E deferred with the rest of the panel
  (B-005 / D-013).
- 200k-item p95 <200ms perf budget is a Remote-CI nightly measurement, not a
  per-PR gate (PERFORMANCE_BUDGET.md).

## [0.3.0] — Phase 3 (2026-10-09)

### Added

- Migration `0005_planner`: ai_providers (kind CHECK + AES-256-GCM
  `encrypted_key` + `key_last4`), ai_calls, plans (status CHECK for the
  10-state lifecycle), plan_revisions (immutable, `UNIQUE(plan_id,revision_no)`),
  replan_suggestions, approval_requests (org/project composite FK).
- AiProvider interface + FakeProvider (deterministic, offline fixture list),
  OpenAiCompatibleProvider, AnthropicProvider; keys decrypted only in the
  resolver, never exposed. AES-256-GCM cipher with key_version for rotation.
- Planner state machine + pure validators (`validatePlan`, `findCycle`,
  `similarity`, `revisionHash`) with unit tests; the plan §7 lifecycle
  table encoded in `TRANSITIONS`.
- createPlan enqueues `planner.generate` via the outbox (services never touch
  BullMQ directly); generatePlan validates output, retries 2× on invalid,
  records `ai_calls`, transitions to `ready` / `needs_clarification` /
  `generation_failed`; a manual revision path exists so the planner works with
  **no** provider configured.
- approvePlan enforces `validation.ok`, `plan:approve`, and self-approval
  (`FORBIDDEN_SELF_APPROVAL`). applyPlan runs in ONE transaction with
  injectable-failure rollback proving zero-partial-data semantics and
  out-of-tx `apply_failed`; apply is a distinct `plan:apply` scope + never
  implied by approve.
- Daily token budget (`ai.daily_token_budget`, default 0 = unlimited) checked
  before each provider call → `AI_BUDGET_EXCEEDED`.
- Manual / auto_low_risk approval matrix (plan §7): agent writes routed through
  `classify()`; low-risk under `auto_low_risk` runs immediately, otherwise a
  `pending_approval` approval_request is created and the endpoint returns
  HTTP 202 `{ status: 'pending_approval', approval_request_id }`. Agents can
  never decide their own approvals; only human admins can.

### Known gaps (recorded)

- Panel Planner / Approvals / AI Providers pages deferred (B-005 / D-013).
- Replan-monitor daily job + `replan_suggestions` UI: schema in place; the
  scheduled job ships in Phase 7 alongside other maintenance jobs.

## [0.5.0] — Phase 5 (2026-10-09)

### Added

- Migration `0007_github`: repositories (composite `UNIQUE(id, organization_id)`
  target + `UNIQUE(provider, external_id)`), project_repositories (composite FKs
  to both projects and repositories), pull_requests (+`draft`/`body`/`merged_at`),
  commits, branches, webhook_deliveries (`organization_id`, `UNIQUE(delivery_id)`,
  `received|processing|done|failed`), external_issue_links (`remote_version`,
  `last_synced_at`, `local_modified_at` for conflict detection), releases.
- Core `secrets.ts`: put/get/find/delete encrypted application secrets using
  the process cipher (§3b-1.5). Env is bootstrap-only — first read copies into
  `secrets` so DB becomes the source of truth.
- `activeCipher()` process-wide cipher holder (installed once per app/worker
  bootstrap) — replaces the per-module `setCipher` and lets both apps share.
- `recordAudit` widened to `DbLike` so worker/one-shot audit writes are legal.
- `github/delivery.ts` (in **core**, so api + worker share one code path):
  `applyPullRequestEvent` (repo + PR upsert, key extraction from branch/title/
  body, auto-transition-on-merge via injected callback reading the project
  setting); `importIssueEvent` (off|import one-way with `sync_conflict` audit
  when local edit > last sync); `recordRelease`; `normalize{PullRequest,Issue}
Payload`. `extractItemKeys`/`extractClosingKeys` (2-5 uppercase letters
  project-key regex) live here and are re-exported from the api.
- Webhook receiver `POST /integrations/github/webhook`: module-gated (503 when
  disabled), constant-time HMAC-SHA256 verification of `X-Hub-Signature-256`
  (401 on mismatch), stores `webhook_deliveries` + an `outbox` row in ONE
  transaction, replies 202. Duplicate `delivery_id` is a no-op still 202.
  Raw-body capture via the shared JSON content-type parser (installed once).
- `github.process_delivery` worker handler dispatches on the delivery event
  (pull_request / issues / release), is idempotent via the delivery status
  guard (at-least-once → exactly-one-effect), writes a `system` audit with
  counts. Registered in the same outbox→dispatcher→BullMQ path as `system.ping`.
- REST endpoints (all module-gated): `GET /repositories`,
  `POST /projects/:id/repositories` (connect),
  `POST /projects/:id/pull-requests` (manual PR link),
  `POST /projects/:id/issues/import` (returns 200/201 with `created|updated|
conflict|skipped`), `POST /projects/:id/releases`,
  `GET /work-items/:key/development` (Development tab), `POST/GET
/integrations/github/{config,status}` (secrets:manage, encrypted at rest).
- `github.issue_sync_mode` registry allows `off|import|export|two_way` per
  plan §12 (columns present) but v1 rejects `export|two_way` with **422** on
  write — the panel-facing "unavailable in this version" contract (plan §9.5).
- MCP: `buildGithubTools(db)` registers the five §13 github tools, each with
  `module: 'github'` so the dispatcher hides them from `tools/list` and rejects
  direct calls with MODULE_DISABLED when the module is off.
- `GithubClient` interface + `FakeGithubClient` (scripted in tests; the octokit
  HTTP path is left to the runtime `pnpm`-installed `@octokit/*` deps pinned in
  `apps/api/package.json`; tests never hit the network per plan §15).

### Tests

- 9 Phase-5 integration cases: boot with zero github config + core unaffected;
  503 MODULE_DISABLED; bad-signature 401 with no delivery row; valid signature
  - resend idempotency; PR key extraction from branch + title (2 links);
    merged+`fixes KEY` moves only that item to completed; secrets not in plaintext
    dump or audit; two repositories visible per project; issue-import mode off /
    import (create + no-dup update + local-edit-after-sync conflict path with
    `github.sync_conflict` audit); release persistence; `export|two_way` → 422.
- 5 worker-driven integration cases: PR delivery links items via keys;
  at-least-once re-run is a no-op; issues delivery imports (mode=import);
  release delivery records a row; the full **outbox → dispatcher → BullMQ →
  handler** path is exercised by a real Worker.
- New unit tests: `verifyWebhookSignature` (valid/Buffer/wrong secret/body
  mismatch/malformed headers/truncated sig), core `delivery.ts` helpers
  (`extractItemKeys` / `extractClosingKeys` / normalizers), the real HTTP
  providers (`OpenAiCompatibleProvider`, `AnthropicProvider`) against a
  loopback mock server (2xx/5xx/invalid-JSON), `maskInput`, `capOutput`,
  `ToolRegistry.visible` (scope + module filter), `estimateTokens`,
  `ProviderError`, `requestHash`, planner state helpers.
- Suite: **173 tests**, `pnpm verify` green (91.4% lines / 80% functions).

### Known gaps (recorded)

- Panel Integrations ← GitHub page (configure/install/sync mode/Development
  tab) and the daily reconciliation job ship in Phase 7 (schema is in place;
  `sync_origin`/`last_synced_at` columns already exist). Recorded in B-005.
- Issue `export`/`two_way` modes are refused with 422 per plan §9.5 (deliberate).

## [0.4.0] — Phase 4a (2026-10-09)

### Added

- Migration `0006_mcp`: `mcp_tool_calls` (call log) + `mcp_servers` (external
  client registry, 4b). Core `ToolRegistry` + `maskInput` + `capOutput` (50 KiB
  truncation per §8.9).
- `/mcp` Streamable-HTTP JSON-RPC handler: initialize / tools-list /
  tools-call / resources-list / prompts-list. Every call runs the §3b-6 order
  at call time (auth → scope → module-enabled → idempotency → service);
  `tools/list` filters by key scopes + enabled modules but is not the security
  control. `mcp_tool_calls` records masked inputs.
- 34 tools registered from projects/work-items/planner/approvals (final §8.4
  planner set with NO `planner_generate_work_items`; separate `plan_approve` /
  `plan_apply` scopes). Handlers only call module services.
- Real MCP SDK client round-trip contract test (Client + InMemoryTransport)
  proving our wire format matches spec-compliant clients; `pnpm mcp:smoke`
  executed green against a live server via `StreamableHTTPClientTransport`.
- Tests: 9 + 2 Phase-4 integration cases covering the full §8 acceptance
  matrix: unauth 401, scope filtering + direct FORBIDDEN_SCOPE, `project_ids`
  key restriction (NOT_FOUND not 403), bulk idempotency via
  `structuredContent`, 120/min rate limit, mask-in-call-log (no raw
  token/key), revoked key rejected at call time (not list), planner contract
  (approve/apply separate scopes, no `planner_generate_work_items`).

### Known gaps (recorded)

- 4b optional MCP client (stdio/HTTP to external servers) deferred behind
  `mcp.client.enabled` (BLOCKERS B-006, D-020). `mcp_servers` table +
  `network.allow_private_targets` are in place for the follow-up.
- Panel MCP settings + `mcp_tool_calls` log viewer deferred with the panel
  (B-005).

## Not yet delivered (per plan gating)

Phases 6–7 and the `v1.0.0-rc.1` release: Code/Refactor reviews, panel
completion (login/setup, projects, work items, planner, approvals, integrations,
MCP, settings, users, audit, jobs, backups, health) with Playwright E2E,
security/perf hardening.

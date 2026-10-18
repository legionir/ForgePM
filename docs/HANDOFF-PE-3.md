# Handoff — PE‑2 is done locally, PE‑3 is the next phase

Written 2026‑10‑18 at the end of the PE‑2 session. This file exists because the previous session was
interrupted twice by a sandbox reset that **rewound git** (see §6), and because the plan's own gates
(`docs/EXECUTION_CONTROL_PLAN.md` §17) require the record to be re-derivable by someone who was not
there. Read §1 and §5 before typing anything; §6 is the list that saves the most time.

## 1. Where the work actually is

| Ref                              | Content                                                                                                                                                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main` on GitHub                 | PE‑0 (PR #9, squash‑merged; `remote: pass` run 39076763818) and PE‑1 (PR #12, merged; `remote: pass` run 39082268502, 22/22 steps). B‑013 records that `ci` is intermittently red on **unchanged** code — so a red run is re-read, never re-guessed. |
| **Nowhere but this workspace**   | **All of PE‑2** — the code in `caa59db` (79 files, +12251/−217) plus the `docs(exec):` commits on top of it. The durable handle is the **range** `bc6f28b..arena/c216c536-forgepm`, not any single sha.                                              |
| `docs/EXECUTION_CONTROL_PLAN.md` | §5 PE‑0 9/9 ticked, §6 PE‑1 8/9 (only A.9 open, deliberately deferred to PE‑12), §7 PE‑2 8/8 ticked, §8 PE‑3 0/12.                                                                                                                                   |

The session branch `arena/c216c536-forgepm` is **closed to GitHub operations** (its PR was merged), and
this sandbox has no route to `github.com` at all (`git ls-remote` fails on a TLS handshake; egress is
limited to the npm/PyPI registries). So PE‑2's `remote:` gate is recorded as `cannot-run`, **not** as a
pass, and PE‑2 is not "closed" in the plan's sense until CI has seen it and `docs/PROGRESS.md` says so.

Two portable copies of the same work sit at the **workspace root** (outside the repo, so they are not
part of the diff): `forgepm-pe-2.bundle` (the whole range; `git bundle verify` says it requires
`bc6f28b`) and `pe2-mail/0001…0003-*.patch` for `git am` (0001 `git apply --check` verified clean against
`bc6f28b`). If the next session gets a fresh clone instead of this workspace, that is how PE‑2 comes
along. **If the branch moves again, refresh both** — they are a snapshot, not a mirror:

```bash
git bundle create ../forgepm-pe-2.bundle bc6f28b..arena/c216c536-forgepm
git bundle verify ../forgepm-pe-2.bundle
git format-patch bc6f28b..arena/c216c536-forgepm -o ../pe2-mail   # git am keeps each commit's author
```

That recovery path is not theoretical: applying `0001…0003` with `git am` onto a clean `bc6f28b` clone
produced a tree whose hash equals this workspace's `HEAD^{tree}`. The commit _shas_ differ afterwards
(`am` rewrites committer and date), so compare trees or `git diff`, and treat no sha in a doc comment as
load-bearing — which is why the record above names a range.

```bash
# preferred — keeps the shas and the commit messages
git fetch /path/to/forgepm-pe-2.bundle arena/c216c536-forgepm
git switch -c pe-2 FETCH_HEAD
git push -u origin pe-2            # then open the PR; CI's verdict goes into docs/PROGRESS.md

# or, if only the patches exist (order matters)
git switch -c pe-2 bc6f28be3ecede5ef095c1ca0cdce004f22a0652
git am /path/to/pe2-mail/0001-*.patch /path/to/pe2-mail/0002-*.patch
```

`docs/PHASENaN_REPORT.md` is present but **untracked on purpose** — a stale `report:phase` artifact
titled "Phase NaN" carrying a `local: fail` verdict that belongs to no phase. Do not commit it; if the
`--phase` parsing in `scripts/phase-report.ts` is ever touched, that is the bug to fix.

## 2. What PE‑2 delivered (so it does not get rebuilt)

- **Five ledger tools** over the real MCP dispatch path: `exec_task_start`, `ledger_add_open_item`,
  `ledger_resolve_item`, `ledger_list_open`, `exec_ledger_status` — built by `buildExecTools(db)` in
  `apps/api/src/modules/exec/mcp-tools.ts`, handlers in `apps/api/src/modules/exec/service.ts`.
- **Schemas with teeth** in `packages/shared/src/schemas-exec.ts`: `strictObject` everywhere, so an
  unknown key is refused with `VALIDATION_ERROR` + `needed_action`; `why_not_blocking` has the
  40–2000 floor; `evidenceInputSchema`, `resolveItemInputSchema`, `taskStartInputSchema`.
- **The criterion law** in `packages/core/src/exec/task-start.ts`: `parseTaskStart` (shape) is separate
  from `checkCriteria` (law), which refuses a vague acceptance criterion **before** anything is written
  (`CRITERION_NOT_CHECKABLE`, listing every bad row, with examples). `createTask` writes work item +
  `exec_tasks` row + one `exec_criteria` per criterion + one `task.created` event + one audit row, in one
  `unitOfWork`; unknown `req_ids` → `NOT_FOUND`.
- **`tools/list` tells the truth now**: `apps/api/src/modules/mcp/json-schema.ts` derives real types,
  bounds, `format:'uuid'`, array limits, `anyOf`, and `additionalProperties:false` exactly when the Zod
  object is strict. The mapper it replaced advertised "extra keys welcome" while the handler refused
  them.
- **`exec_ledger_status`** (`packages/core/src/exec/ledger-status.ts`) = six queries feeding
  `buildLedgerStatus`; `{ empty:true, needed_action }` for a project with no task; `NOT_FOUND` for an
  unknown `task_ref`.
- **`req_ids` declares, it never covers** (D‑049 #2) — the 12th integration test proves the requirement
  stays in `requirements_uncovered`.
- **`gateAgentOperation` is exported** from `apps/api/src/modules/work-items/service.ts` and reused, so
  the agent's ledger writes inherit `work_item.create`'s approval policy instead of re-implementing it.
  Checkability is evaluated **first**: an unexecutable payload never spends an approval slot, and the
  `pending_approval` answer writes no ledger row and no event.
- **`apps/web/e2e.sh` runs in a GPU‑less container**: it derives Chromium launch flags when
  `CHROMIUM_PATH` is set and `CHROMIUM_ARGS` is not (see the trap in §6).

`local:` evidence for the above, measured on the reinstalled toolchain: unit **297/297** (34 files) ·
`exec-tools` **12/12** + `exec-ledger-invariants` **21/21** on real PostgreSQL 18 · lint 0 · typecheck 0 ·
build · `docs:check` · `gen:api:check` ("committed spec + client are up to date") · panel gate
`bash apps/web/e2e.sh` exit 0 (`chain.spec.ts` 2/2, `flagship.spec.ts` 1/1, `visual.spec.ts` 14 opt-in
skips). Full integration suite: 202 passed / 5 failed / 2 skipped — the 5 are the Redis- and
`pg_dump`-bound files (B‑005/B‑009/B‑013), unchanged by PE‑2.

## 3. Incomplete — what is still owed on PE‑2

1. **`remote:` verdict.** Push §1's bundle, let CI run, and write `remote: pass (run <id>)` into the PE‑2
   entry of `docs/PROGRESS.md`. Do not call PE‑2 closed before that line exists; do not fake it either.
2. **Coverage is asserted per slice, not as one number.** The combined `vitest run --coverage` cannot
   print a table here because vitest suppresses the report when any test fails. `npm run verify` in an
   environment that has Redis (and `pg_dump` on PATH) is the arbiter — run it once and paste the table
   into `docs/PROGRESS.md`.
3. **Visual baselines** (D‑046): a `VISUAL=1` probe in a reinstalled container gives 9/14; the five diffs
   are _height_ differences because the per-file `e2e-reset` truncates to an empty install while the
   committed baselines were captured on a populated one. That is a human decision (recapture, or keep
   them opt-in), not a PE‑2 regression. Leave the opt-in default alone unless the owner says otherwise.

## 4. Not started (the rest of the plan, with the plan's own numbering)

| Phase      | What it owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Plan §  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| PE‑3       | `exec_submit_exit_report` (strict `exitReportSchema`, the explicit‑`none_confirmed` rule), `exec_task_complete` = the single gate over the 13 rules, the Gate stamp in `exec_gate_checks`, `deriveStatus`, `buildFinalReport`, WorkItem linkage (I‑1). Acceptance C.1–C.11 + C.9b.                                                                                                                                                                                             | §8      |
| PE‑4       | `ledger_add_evidence`, `ledger_record_decision`, `ledger_ask_human`, REST routes for the human path (`ledger:decide`), **`scripts/ledger-cli.ts`** (D‑11), approvals wiring, `B.9–B.13`.                                                                                                                                                                                                                                                                                       | §9      |
| PE‑5       | risk policy + `exec_policy_check`, scope/diff cross‑check (`SCOPE_VIOLATION`).                                                                                                                                                                                                                                                                                                                                                                                                 | §10     |
| PE‑6       | `docs/LEDGER_RULES.md`, the agent behaviour rules file (D.1–D.5).                                                                                                                                                                                                                                                                                                                                                                                                              | §11     |
| PE‑7       | adversarial review, `review_task`, `E.*`.                                                                                                                                                                                                                                                                                                                                                                                                                                      | §12     |
| PE‑8…PE‑11 | `scope_check`, `baseline_capture` (PE‑8) · `exec_plan_view`, `task_split`, `task_block`, `exec_link_dep`, `req_*` (PE‑9) · `session_start`, `journal_*`, `exec_ledger_reconcile` (PE‑10) · `fact_*` (PE‑11).                                                                                                                                                                                                                                                                   | §13     |
| PE‑12      | the panel: board/status/ledger views over `buildLedgerStatus`, i18n parity (**A.9**), final DoD sweep.                                                                                                                                                                                                                                                                                                                                                                         | §13/§17 |
| bootstrap  | §19 steps 2–9: one REQ per § of the plan, `record_decision` for D‑01…D‑13, `task_split` for PE‑0…PE‑12, `fact_record` + `baseline_capture`, then `exec_submit_exit_report` + `exec_task_complete` for the phase itself. **None of this has ever run**, because it is written against the CLI that does not exist yet — so PE‑0…PE‑2 live in git and in these docs, not in `exec_*` rows. Back‑fill it as real PE‑4 work; never hand‑insert rows to make a gate look satisfied. | §19     |

Only 5 of the tool list in §4.0 exists today. D‑12 stands: all 28 are built and stay visible; no
"core/full" tier, no hidden tool, and still no delete/edit tool for the agent (no `criterion_waive`, no
`req_drop`, no `policy_set`).

## 5. How to start PE‑3 (suggested first hour, red‑green)

1. **Restore and verify, don't trust.** `git log --oneline -3`, `git status --short | wc -l`,
   `ls node_modules | wc -l`. If the tree is a fresh clone, apply §1. If `node_modules` is empty, run
   `npm ci --no-audit --no-fund` at the root **and** `cd apps/web && npm ci` (~10 s each) before
   concluding anything is red.
2. **Bring the database up** (`node apps/web/scripts/dev-postgres.mjs` via a background process, then
   the env in §7). Confirm with the two existing exec integration files: they must read 33/33.
3. **Split `gate.ts` before touching it.** It is **590 lines** and the plan's C.11 caps `gate.ts` at 400
   with each rule ≤ 60 — that bound is already violated by PE‑0's version, and PE‑3 is about to add more
   wiring. Move the rule bodies into `packages/core/src/exec/gate-rules/` (one file per rule, or grouped
   by source table), keep `runGate`/`GateResult` exported from `gate.ts`. The numbering is already pinned
   by `gate.test.ts`'s C.1 case ("exposes exactly 13 numbered rules, contiguous and stable" over
   `GATE_RULES`) — extend that file rather than creating the plan's hypothetical `gate.rules.test.ts`,
   and add C.11's size test, which does **not** exist yet: assert the limits by reading the files, the way
   `tests/unit/eslint-boundaries.test.ts` does.
4. **Write the failing test for the report tool** (`exitReportSchema` in `packages/shared/src/schemas-exec.ts`,
   strict, no `partial`, no `default`): the eight list fields must be non-empty **or** carry
   `none_confirmed.<field>=true`; anything else → `UNPROCESSABLE` (C.3). A missing key is an error (C.3
   contrast: `incomplete: []` with `none_confirmed.incomplete = true` is accepted).
5. **Then the gate tool.** `exec_task_complete` calls `runGate(tx, taskId, { reportId, actorType })`,
   writes the stamp (`ok`, `blocked_by`, `gate_version`, `tree_hash`, `run_source`) into
   `exec_gate_checks` **before** answering, and only then flips status via `deriveStatus`. C.10 asks for
   one fixture per rule (13 unit tests, each asserting `blocked_by[].rule/ref/needed/tool_to_call`),
   C.5 is a penetration test (nothing else may set `done`: `work_item_transition`, REST, direct SQL,
   CLI) and C.9b proves a hand-written `status='done'` without a valid stamp is refused by both
   `exec_ledger_status` and the gate.
6. **One gate run per change, then commit** (Conventional Commits; keep the acronym out of the subject's
   first word — `feat(exec): wire the exit report and the finalization gate (PE-3)`), tick §8's boxes in
   the same commit as the tests, and add the PE‑3 section to `docs/PROGRESS.md` + a CHANGELOG block in
   the same commit as the code.

## 6. Traps that cost real time last session (each one is a measured fact, not a theory)

- **`--single-process` + `--no-zygote` survive exactly one browser launch**: the first spec passes and
  every later one dies with "browser has been closed". And ANGLE/SwANGLE aborts without a GPU
  (`eglInitialize SwANGLE failed with error EGL_NOT_INITIALIZED`, then SIGTRAP). `e2e.sh` now handles
  both; when running a single spec by hand, keep the derived `CHROMIUM_ARGS` and set
  `LD_LIBRARY_PATH` to the extracted `al2023/lib`.
- **kysely `eb.or([eb('code','=',ref), eb('id','=',ref)])` aborts the query** when a `T-001` meets a
  `uuid` column, and dispatch reports a bare `internal error`. Any "id **or** code" lookup needs raw SQL
  with `id::text = ${ref}` — that is what `resolveProject`/`findTaskByRef` do.
- **A fake `Actor` with `apiKeyId` set silently loses every `mcp_tool_calls` row**: the FK insert throws
  inside `logCall`'s `try/catch`. Omit `apiKeyId` in test actors.
- **An agent actor calling a write tool legitimately gets `{pending:true, approval_request_id}` with zero
  writes** unless the org policy is exactly `auto_low_risk`. Ledger write paths in tests need a **user**
  actor; keep one agent test per gated tool to prove the gate.
- **`tests/integration/harness.ts`'s `reset()` truncates `settings`**, which wipes
  `modules.exec.enabled` — so a "second org/project" case must be seeded with another `seedOrg`, not by
  resetting.
- **Coverage plus any red test = no coverage report** (`reportOnFailure:false`). Measure a passing slice
  with `--coverage`, or read CI's table. Never publish an invented total.
- **`docs` are code here**: exact-string patching is fragile (non-breaking U+2011 in the plan breaks
  `sed` ranges; prettier reflows prose). `git diff --cached --stat` is the arbiter, and
  `npx prettier --write` before `npx tsx scripts/docs-check.ts`.
- **`gen:api:check` needs `REDIS_URL`, `FORGEPM_SECRET_KEY` and a prior build** of
  `@forgepm/shared`/`@forgepm/core`; a missing `tsx`/`vitest/config` means the toolchain is gone, not
  that a gate is red.
- **Sandbox resets restore files but rewind git and delete `node_modules`, the `/tmp` clusters and
  background processes** (twice in one session, once destroying an already-made commit). So: commit
  early, record the sha in `docs/PROGRESS.md`, and keep §1's bundle/patches refreshed.
- `0010_exec` facts that keep surprising people: `exec_tasks.allowed_paths` is `jsonb DEFAULT '[]'`;
  `exec_criteria` has **no `requires_evidence` column**; title CHECK is 5..500 and criterion text ≥ 25;
  `work_items.source` has a closed CHECK list, so ledger items are `'manual'` with provenance in
  `exec_events`/`audit_events`; codes come from `allocateLedgerCode` (`T-001`, `C-1`, `OI-001`).
- `npm run lint` inside `apps/web` has ~99 pre-existing `no-undef` errors — run lint from the repo root.

## 7. Command cheat-sheet

```bash
# dev Postgres (data dir under /tmp, two DBs) — start as a background process
FORGEPM_PGDATA=/tmp/pgdata-e2e FORGEPM_PGPORT=5433 FORGEPM_PGDBS=forgepm_e2e,forgepm_test \
  node apps/web/scripts/dev-postgres.mjs

# integration (needs that cluster)
DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5433/forgepm_test" FORGEPM_TEST_NO_REDIS=1 \
  FORGEPM_SECRET_KEY="$(openssl rand -base64 32)" \
  npx vitest run --project integration tests/integration/exec-tools.test.ts

# unit / static gates
npx vitest run --project unit
npm run lint && npm run typecheck && npx tsx scripts/docs-check.ts

# the panel gate (api :3101 + dev-server :4200, DB reset per spec file)
LD_LIBRARY_PATH=/tmp/al2023/lib CHROMIUM_PATH=/tmp/chromium \
  DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5433/postgres" bash apps/web/e2e.sh

# OpenAPI + generated client freshness (PE-3 adds REST routes in PE-4 — then this must be regenerated)
npm run build -w @forgepm/shared -w @forgepm/core && REDIS_URL="redis://127.0.0.1:6379" npm run gen:api:check
```

Rules that never relax (AGENTS.md + the plan): Postgres only (D‑01), one MCP server (D‑02), no Docker
path anywhere in the work or the excuses, every gate reported as `local:`/`remote:` with what actually
ran, tests are never skipped or weakened, migrations are forward-only, `audit_event` in the same
transaction, raw DB/Redis only inside `@forgepm/core`, and a phase advances only when its gates are
green.

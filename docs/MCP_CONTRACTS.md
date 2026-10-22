# MCP Contracts

Full text: EXECUTION_PLAN §8 and §13. Implemented in Phase 4.

## Transports

- The inbound ForgePM MCP server is Streamable HTTP: `POST /mcp` with
  `Authorization: Bearer fpm_…`.
- No inbound stdio proxy/binary is shipped. `forgepm-mcp` is the server's
  reported `serverInfo.name`, not an executable; see `docs/MCP.md` for the
  supported client configuration.
- The separate outbound MCP-client feature can connect to external stdio or
  HTTP servers; it is not a transport into ForgePM's own server.

## Conventions

- Tool names use underscores only (`work_item_create`).
- Each module registers tools in `mcp-tools.ts` with Zod input/output schemas
  and annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`); tools
  call only their module's service.
- Scopes: `read`, `write`, `plan`, `plan_approve`, `plan_apply`, `review`,
  `github`, `admin`, `ledger:read`, `ledger:write`, `ledger:decide`. The last
  scope is human-only; do not issue it to an agent. A tool is listed only if
  the key has its scope and its module is enabled; every call re-checks at
  runtime.
- `project_ids` key restriction applies to every tool, even ones without a
  project parameter (e.g. search).
- Sensitive operations return
  `{ status: "pending_approval", approval_request_id }` instead of executing;
  `approval_decide` requires scope `admin` + a human actor; an agent can never
  approve its own request.
- Create/bulk tools take a mandatory `idempotency_key`; other writes optional.
- Every call is logged to `mcp_tool_calls` with masked inputs.
- Rate limit default 120 calls/min per key; results ≤ 50 KB; truncation always
  announced with `truncated: true`.
- Errors are `isError: true` with `code` + model-readable message; no stack.

## Tool table (Phase 4+)

| Tool                                                                                               | Scope        | Mutating                                  |
| -------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------- |
| `project_list`, `project_get`                                                                      | read         | ✗                                         |
| `project_create`, `project_update`, `project_archive`                                              | admin        | ✓                                         |
| `work_item_list/get/search/get_dependencies`                                                       | read         | ✗                                         |
| `work_item_create/update/transition/add_comment/link/bulk_create`                                  | write        | ✓                                         |
| `feature_list/get/get_progress/get_work_items`                                                     | read         | ✗                                         |
| `feature_create/update`                                                                            | write        | ✓                                         |
| `planner_analyze_project`, `planner_get_plan`, `planner_validate_plan`                             | plan         | ✗                                         |
| `planner_create_plan`, `planner_update_revision`, `planner_apply_plan`, `planner_get_apply_status` | plan         | ✓                                         |
| `planner_approve_plan`                                                                             | plan_approve | ✓ (human actor only)                      |
| `approval_list`                                                                                    | read         | ✗                                         |
| `approval_decide`                                                                                  | admin        | ✓ (human only)                            |
| `github_*` (5)                                                                                     | github       | link ✓ / rest ✗; only with module enabled |
| `review_*`, `refactor_review_*` (8)                                                                | review       | start/update ✓; reports ✗                 |

`planner_generate_work_items` does not exist; item generation is internal to
`create_plan`. Write-tool output envelope:
`{ status, applied, rolled_back, requires_action?, resources, skipped, request_id }`.

## Execution-control tools (PE-1…PE-11, module `exec`)

While `modules.exec.enabled` is false, none of these appear in `tools/list`
at all — the feature is invisible, not merely refused, and every call
re-checks the module and the key's scope at runtime.

| Tool                      | Scope                 | Mutating | What it does                                                                                                                                                                                                                                                                               |
| ------------------------- | --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `exec_task_start`         | write or ledger:write | ✓        | Creates the ledger task, its criteria and work item; the API captures a start commit SHA or, without Git, a hash-only file manifest. The criterion law runs before anything is written.                                                                                                  |
| `req_add`                 | write or ledger:write | ✓        | Records a checkable requirement with a literal quote and provenance; explicit contradictions can open a blocking design gap and human question.                                                                                                                                        |
| `req_link_task`           | write or ledger:write | ✓        | Links one or more task criteria to a requirement. Only `exec_criteria.req_id` is coverage; task `req_ids` are declarations.                                                                                                                                                            |
| `req_change`              | write or ledger:write | ✓        | Revises requirement text; criteria reopen as pending, evidence stays append-only history, dependent decisions become `needs_revisit`, and completed linked tasks reopen with blockers.                                                                                                    |
| `req_coverage`            | read or ledger:read   | ✗        | Shows task declarations separately from linked criteria and evidence-backed coverage; dropped requirements remain visible as history.                                                                                                                                                  |
| `fact_record`             | write or ledger:write | ✓        | Records source-backed knowledge and server-hashes listed files. Guess-as-fact is rejected; a duplicate key supersedes the prior row and preserves both records.                                                                                                                        |
| `fact_query`              | read or ledger:read   | ✗        | Searches project facts; stale facts are returned with `status: stale` and an explicit warning, never as current truth.                                                                                                                                                                 |
| `fact_verify`             | write or ledger:write | ✓        | Re-reads referenced files. A mismatch marks stale, revisits dependent active decisions and files blocking open items; a successful explicit check may reactivate only the fact.                                                                                                            |
| `fact_promote`            | ledger:decide (human) | ✓        | Human-only assumption promotion; a reason is mandatory, any supplied file/commit/command reference is checked, and approval/audit/event rows are written.                                                                                                                                             |
| `task_split`              | write or ledger:write | ✓        | Creates parent-linked child tasks and dependency edges in one transaction; cycle checks fail with `DEPENDENCY_CYCLE`.                                                                                                                                                                   |
| `task_start`              | write or ledger:write | ✓        | Moves an existing task into progress only when dependencies are done; refusals name the complete `pending_deps` list.                                                                                                                                                                  |
| `task_block`              | write or ledger:write | ✓        | Persists the blocker reason, source/ref and unblock condition; blocked tasks leave the started work-item state.                                                                                                                                                                        |
| `exec_link_dep`           | write or ledger:write | ✓        | Adds a task dependency and rejects self-, two-task and longer cycles.                                                                                                                                                                                                                 |
| `exec_plan_view`          | read or ledger:read   | ✗        | Returns the full project task tree, dependencies, requirement declarations/criteria, blocker details and uncovered requirements; `blocked` differs from `awaiting_human`.                                                                                                               |
| `ledger_features`         | read or ledger:read   |   | Lists the project's features: `{ project_id, items: [{ id, key, title, lifecycle_status, milestone_id }] }`. Use a key as `feature_ref`. |
| `ledger_milestones`       | read or ledger:read   |   | Lists the project's milestones: `{ project_id, items: [{ id, name, status, target_date }] }` (`include_closed` defaults to true). Use a name or id as `milestone_ref`. |
| `ledger_feature_create`   | write or ledger:write | ✓ | Creates a feature `{ key, title, description?, milestone_ref?, acceptance_criteria? }` through the same repository and audit (`feature.create`) as the panel. A duplicate key (any letter case) is `CONFLICT`. |
| `ledger_milestone_create` | write or ledger:write | ✓ | Creates an open milestone `{ name, target_date? }` (audit `milestone.create`). A duplicate name (any letter case) is `CONFLICT`. |
| `ledger_projects`         | read or ledger:read   |   | Lists the projects this key can use: `{ items: [{ id, key, name, status }], bound_to_project_ids, hint }`. Archived projects only with `include_archived: true`. A key bound to some projects sees only those. It exists because a ledger-only key cannot see `project_list`. |
| `session_start`           | read or ledger:read   | ✓ (recovery) | Converts interrupted `started` actions to `unknown`, then returns six priority-ordered sections within `min(exec.session_output_max_bytes, 50 KiB - 512 bytes)`; omitted rows carry counts and read hints. Recent unblocks and uncovered requirements remain available. |
| `journal_start`           | write or ledger:write | ✓        | Captures the Git root tree (`HEAD:.`, or the exact `HEAD^{tree}` root equivalent) and `git status --porcelain` server-side, then records the action before it happens. The agent cannot submit a pre-state reference.                                                                                                                                                  |
| `journal_done`            | write or ledger:write | ✓        | Settles a verified `started` or `unknown` action as done with an optional result reference/note. The database allows settlement exactly once.                                                                                                                                                               |
| `journal_fail`            | write or ledger:write | ✓        | Settles a verified `started` or `unknown` action as failed; a failure note is required.                                                                                                                                                                                                                     |
| `exec_ledger_reconcile`   | read or ledger:read   | audit/event | Reports post-close file-hash drift, missing/failed gate stamps, stale facts, unsettled journals, and differences between measured Git paths and report `changed_files`.                                                                                                                                        |
| `ledger_add_open_item`    | write or ledger:write | ✓        | Files an open item — the only write path for "this is not done"; there is no delete.                                                                                                                                                                                                       |
| `ledger_resolve_item`     | write or ledger:write | ✓        | Closes an item with a note (≥ 20 chars); a soft closure of a blocking item is human-only.                                                                                                                                                                                                  |
| `ledger_list_open`        | read or ledger:read   | ✗        | Lists the open items, active first, closed ones as history.                                                                                                                                                                                                                                |
| `exec_ledger_status`      | read or ledger:read   | ✗        | What still blocks submission: blockers, criteria without evidence, unanswered questions, decisions, and the drift between the board and the gate.                                                                                                                                          |
| `ledger_add_evidence`     | write or ledger:write | ✓        | Attaches proof to a criterion: the ref is read before anything is written (a path that is not there is `EVIDENCE_INVALID`, a log with no result line is a paraphrase), secrets are masked on the way in, and the evidence, the criterion it verifies and the ledger event commit together. |
| `ledger_record_decision`  | write or ledger:write | ✓        | Records a choice with its reasons. The risk level is COMPUTED from the policy table — the agent may not send it — and a decision that needs approval is stored as `pending` with `do_not_apply_until_human_approval:true`. A denied decision is not recorded at all.                       |
| `ledger_ask_human`        | write or ledger:write | ✓        | Asks the human a question the ledger keeps: the options, the recommendation, why it matters, and the impact of each option. A blocking question parks the task in `awaiting_review`, and there is no timeout — silence is not approval.                                                    |
| `exec_policy_check`       | read or ledger:read   | conditional | "What would the policy say about this?" — the level, matched rules and next tool. It creates no decision or approval; a `deny` result appends only a `policy.denied` event so the blocked attempt is auditable. The same table reads and decides. |
| `exec_submit_exit_report` | write or ledger:write | ✓        | The strict exit report: every field present, each of the eight "none" fields listed or confirmed empty; every finding is filed as an open item with `source=exit_report` in the same transaction.                                                                                          |
| `scope_check`             | read or ledger:read   | ✗        | Measures changed paths from a server-captured Git SHA or hash-only manifest; report `changed_files` claims are never used as measurement.                                                                                                                                                  |
| `baseline_capture`        | write or ledger:write | ✓        | Fetches exact-SHA CI logs through the configured HTTPS endpoint, parses named per-test results and stores provenance. ForgePM never runs repository code; missing or mismatched logs fail Rule 12 closed.                                                                                   |
| `review_task`             | review                | ✓        | Runs six fixed adversarial review lenses over five isolated ledger sections and a read-only Git diff under `exec.allowed_repo_roots`. Findings require witnesses, are persisted with review/AI-usage/audit rows, and blocking or stale verdicts fail gate rule 7. One corrective output retry; maximum two rounds; unresolved failure creates a human-arbitration blocker. |
| `exec_task_complete`      | write or ledger:write | ✓        | The single gate: the thirteen rules, the gate stamp, and the status the gate implies. A refusal is an answer (`{ok:false, blocked_by:[…]}`), not an error.                                                                                                                                 |

PE-9 preserves D-049/D-058: no requirement↔task table exists. `req_ids` on task creation are declarations only; criterion `req_id` is the coverage link. PE-11 registers fact tools; `fact_promote` is visible only to a human key with `ledger:decide`. `fact_record` hashes named files server-side, refuses guess-as-fact and supersedes duplicate keys without deleting history. File references must exist under `exec.allowed_repo_roots`, commit references must resolve, and command output must cite a completed journal result. Staleness is checked at `session_start`, before `exec_task_complete`, and by the worker's periodic verifier; stale dependencies move decisions to `needs_revisit` and create blocking items. `fact_query` preserves stale status and returns a warning. `task_cancel` is intentionally not an agent tool: a human uses `POST /api/v1/exec/tasks/:parentRef/children/:childRef/cancel` with `ledger:decide`, and the cancellation is recorded as an approval plus a parent-gate waiver. PE-10 adds a dispatch-level agent write lock for unresolved journal rows. Reads, reconciliation, journal settlement, human questions, and policy-computed approval decisions remain available; a retry is permitted only when the single unknown row is idempotent and the task/action/target/expected_effect match exactly. A safe retry appends `journal.retry_started`. Post-close file hashes are stored on the append-only gate stamp for reconciliation. `session_start` returns a `SessionSnapshot`; no shell/editor hook is installed because that hook is optional.

**Work item fields.** `exec_task_start` and every `task_split` child accept optional `type` (task, bug, feature_task, improvement, refactor, research, chore; default `task`), `priority` (none, low, medium, high, urgent; default `none`), `milestone_ref` (milestone id or exact unique name) and `feature_ref` (feature key in any letter case, id, or exact unique title). The state is not an input: a new task starts in the project's first workflow state and the ledger moves it. A ref that matches nothing fails with `NOT_FOUND` listing the features or milestones that exist; an ambiguous name fails with `VALIDATION_ERROR` listing the matches. The approval gate sees the real type and priority (for `task_split`, the riskiest child), so an agent asking for `urgent` or a `bug` can need human approval under `auto_low_risk`.

**`project_ref`** (optional on every ledger tool) names the project to write into: the project **id**, the project **key in any letter case** (`ZNITH`, `znith`), or an **exact project name** when exactly one visible project has that name (two projects with the same name fail with `VALIDATION_ERROR` listing both keys). It is not needed when the API key is bound to a single project. A reference that matches nothing fails with `NOT_FOUND` whose message and `details` list the projects the key can use (`available`) and a `did_you_mean` candidate; the list never includes projects outside the key's `project_ids`. `session_start` returns the resolved `project: { id, key, name }`. `tools/list` carries a description for every parameter that has one (the zod `.describe()` text); `project_ref`, `task_ref`, `criterion_ref`, `item_ref` and the task-start fields say what the value is and where to get one.

`baseline_capture` takes only `{ task_ref, project_ref? }`. Administrators configure `exec.ci_log_endpoint` as an HTTPS URL template containing `{sha}` (or a URL to which ForgePM appends `?sha=`), plus `exec.ci_log_secret_name` naming a **read-only token in the encrypted system secrets store**. The endpoint returns `{sha, run_id, job, provider?, log}` JSON for that exact SHA. Redirects are refused, the response is capped at 1 MiB and 8 seconds, and the SSRF guard blocks private targets unless `network.allow_private_targets` is explicitly enabled. The raw log and token are never returned or stored; provenance records the log SHA-256. Missing CI evidence is waived only through the human-only baseline route.

`scope_check` is read-only and never trusts report claims. A scope-measurement waiver is available only while server measurement is unavailable, through the human-only `POST /api/v1/exec/tasks/:taskId/scope/waive` route with an approval/reason trail; the API rejects it when scope is measurable. Measured out-of-scope files and deletions cannot be waived this way. A human can explicitly expand paths via `POST /api/v1/exec/scope/:taskId/expand`; that union change is recorded, and deletions still require their own approval or restoration.

`review_task` takes `{ task_ref, project_ref? }` and returns the verdict, round,
run id, witness-bound findings count, open-item codes, token usage and status
(`completed`, `review_failed`, `stale`, `review_in_progress`,
`human_arbitration_required`, or `round_limit_reached`). It supplies exactly five isolated sections
(request, criteria/evidence, allowed-root Git diff/hash, ledger status and exit report) across six
fixed review lenses; the model has no tools. Missing `start_ref`, allowed roots, or a verifiable Git
snapshot fails closed with `REVIEW_INPUT_UNAVAILABLE`; the adapter runs only fixed read-only Git
commands and never executes repository code.

After at most two failed rounds, only a human closing the reviewer-created
`risk` item titled `human arbitration required` can override the failed verdict
in Gate rule 7. Its ledger reference is bound to the task, round, and review
hash, so a lookalike finding or an old arbitration item cannot authorize a new
verdict. That does not override a stale tree hash or any other active blocker;
reviewer findings must be resolved separately.

A key needs **one** of the listed scopes — the ledger's own or the generic
one. The ledger scopes let an agent drive the execution ledger without
holding the product's general `write` (plan §4.0, D‑053).

`exec_task_complete` answers with the same words everywhere: a refusal is
`{ok:false, gate_version, blocked_by:[{rule, ref, title, needed, tool_to_call}]}`
— the same five keys for every one of the thirteen rules, so an agent never
finds a field missing on one rule and present on another. A pass is
`{ok:true, stamp_id, gate_version, final_report}`, and the `final_report` is
built from the ledger, never from the message.

## Resources & prompts

- Resources: `forgepm://projects/{key}`, `forgepm://work-items/{key}`,
  `forgepm://features/{key}`.
- Prompts: `plan_feature`, `triage_issue`, `review_finding`.

## Outbound MCP client (Phase 4b, behind `mcp.client.enabled`)

This is ForgePM connecting to external servers, not an alternate transport for
agents connecting to ForgePM. External servers are registered only by admins
with explicit confirmation; only allowlisted `readOnlyHint` tools are usable;
stdio servers run sandboxed (absolute allowlisted commands, own process,
timeouts, memory caps, no inherited env, path/network allowlists); credentials
are encrypted in `secrets` and masked in logs; HTTP targets are SSRF-checked,
with HTTPS mandatory except explicit localhost.

For the inbound ForgePM endpoint and client config, see `docs/MCP.md`.
`npm run mcp:smoke` exercises the implemented Streamable-HTTP endpoint when a
local server and API key are available; it is not a stdio-proxy check.

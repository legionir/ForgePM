# Review Configuration (Phase 6)

Source: EXECUTION_PLAN §10. Code Review and Refactor Review are two optional
modules sharing one review engine (runs, findings, fingerprints, policies).
Both default `false`, controlled at system level and overridable per project.

## Shared registry `review.*` (one source for both modules)

| Key | Values / default |
| --- | --- |
| `review.auto_run` | bool, false |
| `review.issue_policy` | `record_only` (default) / `human_approval` / `auto_high_severity` |
| `review.min_confidence` | 0.6 |
| `review.max_attempts` | 2 |
| `review.max_cost_tokens` | unset |
| `review.github_output` | `off` (default) / `summary` / `inline` |
| `review.ignore_globs` | lockfiles, `dist/**`, `*.min.js`, generated |

Module-specific keys live only under `code_review.*` (stages, `custom_rules`,
`skip_drafts`, `max_diff_bytes` = 200 KB) and `refactor_review.*`
(`min_severity` = medium, `categories`, `max_snippet_tokens`,
`max_files_per_run` = 5,000 per run — not a repo cap). Effective value:
project ← organization ← system. Redeclaring `review.*` under a module prefix
is rejected with `422`.

## Findings

- Required structure: category, severity, confidence, file, line_start/end,
  title, description, why_it_matters, suggestion, evidence (≤20 lines);
  refactor adds impact, effort, risk.
- `fingerprint = sha256(project_id + category + file + normalized_title +
  hash(normalized_evidence))`, line-independent; unique with
  `UNIQUE(project_id, scope_key, fingerprint)`; scope is `pr:<repo>:<number>`
  or `repo:<repo>`.
- Evidence validated against real file content at the run's commit (and within
  diff hunks for Code Review); invalid → discarded, counted in
  `run.stats.discarded`; below `min_confidence` → not stored.
- Statuses: open / dismissed / accepted / issue_created / not_seen / fixed.
  `fixed` only after 2 consecutive complete runs without the finding (or human
  confirmation); truncated/failed runs don't count.

## Issue creation policy

`record_only` stores nothing as items; `human_approval` queues an
`approval_request`; `auto_high_severity` auto-creates items for
severity ≥ high and confidence ≥ 0.8 (code) / 0.85 (refactor), max 10 per run;
each creation unique by `finding_id`. Created items carry label
`agent-ready` + acceptance criteria; code changes are applied only by external
agents through MCP.

## GitHub output

One comment tagged `<!-- forgepm:review -->`, updated in place on later runs
(never duplicated); `off` performs no write calls.

## Refactor sources

`github`: shallow clone to a temp worker dir (removed on success/failure);
`local`: read-only path under `REPO_MOUNT_ROOT`. Deterministic analyzer first
(counts, AST metrics for TS/JS, rolling-hash duplication ≥6 lines/50 tokens,
import graph + cycles + fan-in/out) stored in `code_structure_index` per
commit_sha; AI stages (architecture, duplication, complexity, dependency,
maintainability) see only the index + selected snippets. Partitioned runs
advance `run.stats.partition_cursor`; incremental runs re-check changed paths
+ direct dependents.

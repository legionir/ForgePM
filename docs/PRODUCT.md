# ForgePM — Product

ForgePM is a self-hosted platform for engineering planning and management.
Its core runs independently of AI and GitHub; AI interacts through MCP.
Source of truth for scope: `docs/EXECUTION_PLAN.md` §1. Summary below.

## Non-negotiable principles

1. The project-management core (projects, work items, features, milestones,
   planner) works without GitHub and without any AI provider.
2. All data writes go through Application Services only; MCP, REST and the
   panel call the same services — nothing touches the DB directly.
3. Every change produces an `audit_event`; every delete is soft; domain
   change, audit and outbox are one transaction.
4. Every list is cursor-paginated; no endpoint returns unlimited rows.
5. Any write from MCP or webhook is replay-safe via `idempotency_key`.
6. "Unlimited projects" means no artificial caps in code/config.
7. Optional modules are always registered; enabled-ness is read from settings
   at runtime; every permission check happens at request time, not only in
   `tools/list`.
8. Migrations are forward-only; the panel ships with every phase from Phase 1.

## Definitive product decisions (plan §1)

- Hosting: mode B, self-hosted with an organization boundary from day one
  (`organization_id` on top-level tables + composite-FK tenancy), one default
  org in seed, no billing.
- Ownership: Organization + Membership + ProjectMember. Org roles
  owner/admin/member/viewer; project roles lead/contributor/viewer.
- Planner AI: both modes via `approval_policy` (`manual` default,
  `auto_low_risk`); "low-risk" defined per-operation in Phase 3.
- GitHub independence: complete; module always registered, active only when
  enabled; the core has zero GitHub imports.
- Refactor Review: all three issue-policy modes; analysis/decision/execution
  separated; code changes are executed only by external agents over MCP.
- MCP: built-in MCP Server mandatory in v1; MCP Client optional (Phase 4b)
  behind a feature flag.

## Additional settled details

- Human-readable ids: project `key` 3–5 letters unique per org; work items get
  per-project sequence numbers shown as `FPM-123`.
- Workflow: per-project states mapped to fixed categories `backlog`,
  `unstarted`, `started`, `in_review`, `completed`, `canceled`; progress is
  computed on categories only.
- Priority: none / low / medium / high / urgent.
- Actor: `user`, `agent`, `system`; agents have identity + own API key;
  assignee may be an agent.
- Saved Views (personal or shared) in v1; Cycles/Sprints and Time Tracking are
  out of scope.
- Search: PostgreSQL full-text (`tsvector`) over title, description, comments.
- Notifications: in-app only + optional outbound webhook; email out of scope.
- UI bilingual (fa RTL, en); default timezone `Asia/Tehran`, stored in UTC.

## Deliberately NOT in version 1

Microservices, automatic code-change execution, full two-way GitHub sync,
general workflow engines.

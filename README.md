# ForgePM

Self-hosted engineering planning & management platform. The core (projects,
work items, features, milestones, planner) runs **without GitHub and without
any AI provider**; AI agents interact through a built-in MCP server.
Bilingual panel (فارسی RTL / English).

> Status: Phase 0 (`v0.0.0`) — scaffold, infra layer, module lifecycle,
> transactional outbox + sweeper, schema contract, docs, CI. See
> `docs/EXECUTION_PLAN.md` for the full roadmap and `CHANGELOG.md`.

## Quick start (≤ 5 commands)

```bash
cp .env.example .env                # fill DATABASE_URL / REDIS_URL / FORGEPM_SECRET_KEY
docker compose up -d                # api + worker + web + postgres + redis
npm install && npm run migrate        # apply forward-only migrations
npm run seed                           # default org (idempotent)
curl http://localhost:3001/health/ready
```

## Development

```bash
npm install
cp .env.example .env   # set DATABASE_URL, FORGEPM_SECRET_KEY (npm start creates .env if missing)
npm start              # API :3001 + worker + panel :4200, all in one terminal (alias: npm run dev)
# individual services:
npm run dev:api      # http://localhost:3001
npm run dev:worker
npm run verify       # lint + typecheck + unit + integration + coverage + build
npm run schema:check # live schema vs docs/DATA_MODEL.md
npm run docs:check   # required docs + internal links
```

## Repo map

```
packages/shared  zod contracts, enums, error codes      packages/core  db/queue/outbox/module registry
apps/api         Fastify + modules                      apps/worker    dispatcher/sweeper/handlers
apps/web         Angular panel (fa/en)                  docs/          all design & ops docs
scripts/         seed, backup, restore, doctor, publish
```

## Docs

- [Execution control plan (agent gate system)](docs/EXECUTION_CONTROL_PLAN.md) — phases PE‑0…PE‑12
- [Agent ledger rules](docs/LEDGER_RULES.md) · [Execution-control field report](docs/EXECUTION_CONTROL.md)
- [Product](docs/PRODUCT.md) · [Architecture](docs/ARCHITECTURE.md) ·
  [Data model (schema contract)](docs/DATA_MODEL.md) ·
  [Security](docs/SECURITY.md) · [REST contracts](docs/API_CONTRACTS.md) ·
  [MCP contracts](docs/MCP_CONTRACTS.md) · [Client config](docs/MCP.md) ·
  [Execution plan](docs/EXECUTION_PLAN.md) · [Acceptance criteria](docs/ACCEPTANCE_CRITERIA.md) ·
  [Performance budget](docs/PERFORMANCE_BUDGET.md) · [GitHub guide](docs/GITHUB.md) ·
  [Reviews guide](docs/REVIEWS.md) · [Runbook](docs/RUNBOOK.md) ·
  [Scaling](docs/SCALING.md) · [Decisions](docs/DECISIONS.md) ·
  [Blockers](docs/BLOCKERS.md)

## Execution control

The execution ledger is the only source of truth for agent work. Every task has
server-measured scope (`allowed_paths` + Git/manifest), CI-verified baseline
(`exec.ci_log_endpoint`), and a 13-rule finalization gate. Agents use the
MCP server over Streamable HTTP (`POST /mcp`, `forgepm-mcp` as `serverInfo.name`);
humans use the panel (`/exec-tasks`, `/exec-policy`, Work Item “Execution
control”, Approvals) or the CLI (`npm run ledger -- …`) with `ledger:decide`.
No repo code is ever executed by ForgePM (D-041/D-063). See
`docs/EXECUTION_CONTROL_PLAN.md` for the full gate and `MCP_CONTRACTS.md` for
the 28 tools. E2E proof: `npm run exec:e2e` (13 scenes).

## Agent rules

Executing agents must follow `AGENTS.md` (phase loop, hard rules, definition
of done) before touching anything.

## License

MIT

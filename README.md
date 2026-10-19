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
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis
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

## Agent rules

Executing agents must follow `AGENTS.md` (phase loop, hard rules, definition
of done) before touching anything.

## License

MIT

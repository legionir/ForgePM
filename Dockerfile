# Multi-stage build for api + worker (plan §4.8).
# The runtime stage carries the pnpm workspace node_modules produced at build
# so workspace-linked deps (kysely, bullmq, fastify, ...) resolve for both
# apps and @forgepm/core.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc* ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY tests/package.json tests/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @forgepm/shared --filter @forgepm/core --filter @forgepm/api --filter @forgepm/worker run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd -g 10001 forgepm && useradd -m -g 10001 -u 10001 forgepm
COPY --from=build --chown=forgepm:forgepm /app /app
USER forgepm

FROM runtime AS api
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3001/health/live || exit 1
CMD ["node", "apps/api/dist/main.js"]

FROM runtime AS worker
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "process.exit(0)"
CMD ["node", "apps/worker/dist/main.js"]

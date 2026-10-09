# apps/web/Dockerfile — build the Angular panel and serve the static bundle
# via nginx (5 services in compose: api, worker, web, postgres, redis).
FROM node:22.23-alpine AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate
COPY apps/web/package.json apps/web/pnpm-lock.yaml apps/web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY apps/web ./
RUN pnpm exec ng build --configuration production

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist/web/browser /usr/share/nginx/html/
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

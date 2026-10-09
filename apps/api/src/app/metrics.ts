import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { defaultRegistry, type Db, type Labels } from '@forgepm/core';

/**
 * Plan §14 observability — Fastify hooks + `/metrics` endpoint against the
 * process-wide MetricsRegistry. Installed ONLY when METRICS_ENABLED; the
 * scrape derives queue length and failed-job totals live from the DB, while
 * HTTP request count/latency accumulate from hooks. AI/MCP call counters are
 * incremented by their respective modules via `defaultRegistry`.
 */
const latencyStart = new WeakMap<object, number>();

function routeLabel(url: string): string {
  // Collapse dynamic ids to keep cardinality bounded (no raw uuids in labels).
  return url.split('?')[0].replace(/\/[0-9a-fA-F-]{36}/g, '/:id').replace(/\/[0-9]+(?=\/|$)/g, '/:n');
}

export function installMetrics(app: FastifyInstance, db: Db): void {
  defaultRegistry.setBuckets('http_request_duration_seconds', [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]);

  app.addHook('onRequest', async (req) => {
    latencyStart.set(req, Date.now());
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const started = latencyStart.get(req);
    const seconds = started ? (Date.now() - started) / 1000 : 0;
    const labels: Labels = {
      method: req.method,
      route: routeLabel(req.url),
      status: String(reply.statusCode),
    };
    defaultRegistry.inc('http_requests_total', labels);
    defaultRegistry.observe('http_request_duration_seconds', seconds);
    return payload;
  });

  app.get('/metrics', async (_req, reply) => {
    // derive queue/failed totals from the durable store on each scrape
    let queued = 0;
    let failed = 0;
    try {
      const q = await sql<{ c: string }>`SELECT count(*)::text c FROM jobs WHERE status = 'queued'`.execute(db);
      const f = await sql<{ c: string }>`SELECT count(*)::text c FROM jobs WHERE status = 'failed'`.execute(db);
      queued = Number(q.rows[0].c);
      failed = Number(f.rows[0].c);
    } catch {
      /* metrics must never 500 because of a scrape-time query failure */
    }
    defaultRegistry.gauge('forgepm_queue_length', queued);
    defaultRegistry.gauge('forgepm_jobs_failed', failed);
    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return reply.send(defaultRegistry.prometheus() + '\n');
  });
}

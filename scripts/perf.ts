import autocannon from 'autocannon';
import { createDb } from '@forgepm/core';

/**
 * pnpm perf — PERFORMANCE_BUDGET.md load gates P-01..P-03 with autocannon
 * against the `pnpm seed:perf` dataset: 20 connections, 30s warm-up, 60s
 * measurement, p95 thresholds and the 20% fail band (§3b-7). P-04 (no
 * seq-scan) lives in phase7-explain.test.ts; P-05/P-06 are panel gates
 * (Playwright first paint, angular.json bundle budget).
 * Exit != 0 when any metric crosses its fail threshold.
 *
 * Env: PERF_URL (:3101), PERF_PROJECT_ID, PERF_API_KEY (Bearer),
 * PERF_WARMUP (30), PERF_DURATION (60), PERF_CONNECTIONS (20), DATABASE_URL.
 */
const URL_BASE = process.env.PERF_URL ?? 'http://127.0.0.1:3101';
const CONN = Number(process.env.PERF_CONNECTIONS ?? 20);
const WARMUP = Number(process.env.PERF_WARMUP ?? 30);
const DURATION = Number(process.env.PERF_DURATION ?? 60);
const AUTH = process.env.PERF_API_KEY ? { authorization: `Bearer ${process.env.PERF_API_KEY}` } : {};

interface Metric {
  id: string;
  path: string;
  threshold: number;
  fail: number;
}

async function run(m: Metric): Promise<number> {
  // §3b-7: 30s warm-up (discarded) then a 60s measurement window.
  await autocannon({ url: `${URL_BASE}${m.path}`, connections: CONN, duration: WARMUP, headers: { ...AUTH } });
  const res = await autocannon({ url: `${URL_BASE}${m.path}`, connections: CONN, duration: DURATION, headers: { ...AUTH } });
  // autocannon exposes p50/p90/p99 (no p95); p99 is the stricter stand-in —
  // passing at p99 implies passing at p95 (recorded in DECISIONS D-035).
  const p95 = res.latency.p99 ?? res.latency.average;
  const line = `${m.id} ${m.path}: p95(p99)=${p95}ms avg=${res.latency.average}ms errors=${res.errors} (pass<${m.threshold} fail>${m.fail})`;
  if (p95 > m.fail) {
    console.error(`FAIL ${line}`);
    return 1;
  }
  if (p95 > m.threshold) console.warn(`WARN ${line}`);
  else console.log(`PASS ${line}`);
  return 0;
}

async function main(): Promise<void> {
  let projectId = process.env.PERF_PROJECT_ID ?? '';
  if (!projectId && process.env.DATABASE_URL) {
    const db = createDb(process.env.DATABASE_URL);
    const row = await db
      .selectFrom('work_items')
      .select('project_id')
      .groupBy('project_id')
      .orderBy((eb) => eb.fn.count('id'), 'desc')
      .limit(1)
      .executeTakeFirst();
    projectId = row?.project_id ?? '';
    await db.destroy();
  }

  const metrics: Metric[] = [
    { id: 'P-01', path: '/api/v1/projects?limit=50', threshold: 150, fail: 180 },
    { id: 'P-03', path: '/api/v1/search?q=perf&limit=20', threshold: 250, fail: 300 },
  ];
  if (projectId) {
    metrics.unshift({ id: 'P-02', path: `/api/v1/projects/${projectId}/work-items?limit=50`, threshold: 200, fail: 240 });
  }

  let worst = 0;
  for (const m of metrics) worst = Math.max(worst, await run(m));
  process.exit(worst);
}

main().catch((e) => {
  console.error((e as Error).stack ?? String(e));
  process.exit(1);
});

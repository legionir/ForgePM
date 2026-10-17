import { Client } from 'pg';
import { Queue } from 'bullmq';
import { sql } from 'kysely';
import type { Redis } from 'ioredis';
import { createDb, createRedis, runMigrations, migrations, QUEUES, type Db } from '@forgepm/core';

/**
 * Integration harness — real Postgres + Redis on localhost (local server or
 * CI service container). Each test FILE gets an isolated database (created
 * and dropped around the file), so files never interfere with each other.
 *
 * Database creation goes over the `pg` client, not `psql`: shelling out made the
 * whole integration suite depend on a client binary being on PATH, which is a
 * machine fact and not a project one (D-043 — the same class as the hardcoded
 * path that once made the panel E2E unrunnable off one laptop). `DROP … WITH
 * (FORCE)` (PG14+) replaces a sleep-and-hope around draining pool sockets.
 *
 * `FORGEPM_TEST_NO_REDIS=1` runs the DB-only suites against a Postgres with no
 * Redis present (queue-less files like `exec-ledger-invariants`). Anything that
 * touches `h.queue` then fails loudly by construction — the flag never makes a
 * queue test pass silently.
 */
export interface Harness {
  db: Db;
  redis: Redis | undefined;
  queue: Queue | undefined;
  queueName: string;
  /** Wipe all data between cases (same file, same DB). */
  reset(): Promise<void>;
  cleanup(): Promise<void>;
}

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/forgepm_test';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

export async function createHarness(): Promise<Harness> {
  // Isolated per-file database, named after the base DB + pid + random.
  const base = new URL(BASE_URL);
  const dbName = `${base.pathname.slice(1)}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  const adminUrl = new URL(BASE_URL);
  adminUrl.pathname = '/postgres';
  await withAdminDb(adminUrl.toString(), `CREATE DATABASE ${quoteIdent(dbName)}`);
  base.pathname = `/${dbName}`;

  const noRedis = process.env.FORGEPM_TEST_NO_REDIS === '1';
  const db = createDb(base.toString());
  await runMigrations(db, migrations);
  const redis = noRedis ? undefined : createRedis(REDIS_URL);
  // Namespace the queue per isolated DB so test files never collide on shared
  // BullMQ keys. Dispatcher/Sweeper/Worker all use this one queue name (passed
  // explicitly), so at-least-once semantics hold within a file.
  const queueName = `${QUEUES.default}-${dbName}`;
  const queue = redis ? new Queue(queueName, { connection: redis }) : undefined;

  return {
    db,
    redis,
    queue,
    queueName,
    async reset() {
      await queue?.drain(true);
      await queue?.obliterate({ force: true }).catch(() => undefined);
      // Truncate every public table except the Kysely migration bookkeeping,
      // in one CASCADE statement. Dynamic so new phase migrations' tables are
      // covered without editing this list every phase.
      const { rows } = await sql`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename NOT LIKE 'kysely_%'
      `.execute(db);
      const names = (rows as { tablename: string }[]).map((r) => r.tablename);
      if (names.length > 0) {
        const list = names.map((n) => `"${n}"`).join(', ');
        await sql.raw(`TRUNCATE ${list} CASCADE`).execute(db);
      }
    },
    async cleanup() {
      await queue?.obliterate({ force: true }).catch(() => undefined);
      await queue?.close();
      await db.destroy();
      redis?.disconnect();
      // FORCE closes other backends itself; the retry only covers a socket still
      // mid-disconnect on slow runners, and a leaked DB is loudly visible anyway.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await withAdminDb(adminUrl.toString(), `DROP DATABASE IF EXISTS ${quoteIdent(dbName)} WITH (FORCE)`);
          break;
        } catch (err) {
          if (attempt === 2) throw err;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    },
  };
}

/** One connection to the maintenance database, for CREATE/DROP DATABASE only. */
async function withAdminDb(connectionString: string, statement: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

/** Generated names only, but quote properly — string-built DDL should never be loose. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** OutboxDispatcher/JobSweeper take a Queue; each harness queue is namespaced per file. */
export type HarnessQueue = Queue;

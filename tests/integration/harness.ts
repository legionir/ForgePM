import { execSync } from 'node:child_process';
import { Queue } from 'bullmq';
import { sql } from 'kysely';
import type { Redis } from 'ioredis';
import { createDb, createRedis, runMigrations, migrations, QUEUES, type Db } from '@forgepm/core';

/**
 * Integration harness — real Postgres + Redis on localhost (local server or
 * CI service container). Each test FILE gets an isolated database (created
 * and dropped around the file), so files never interfere with each other.
 */
export interface Harness {
  db: Db;
  redis: Redis;
  queue: Queue;
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
  execSync(`psql ${JSON.stringify(adminUrl.toString())} -c ${JSON.stringify(`CREATE DATABASE ${dbName}`)}`, { stdio: 'pipe' });
  base.pathname = `/${dbName}`;

  const db = createDb(base.toString());
  await runMigrations(db, migrations);
  const redis = createRedis(REDIS_URL);
  // Namespace the queue per isolated DB so test files never collide on shared
  // BullMQ keys. Dispatcher/Sweeper/Worker all use this one queue name (passed
  // explicitly), so at-least-once semantics hold within a file.
  const queueName = `${QUEUES.default}-${dbName}`;
  const queue = new Queue(queueName, { connection: redis });

  return {
    db,
    redis,
    queue,
    queueName,
    async reset() {
      await queue.drain(true);
      await queue.obliterate({ force: true }).catch(() => undefined);
      await sql`TRUNCATE outbox, jobs, idempotency_keys, settings CASCADE`.execute(db);
    },
    async cleanup() {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
      await db.destroy();
      redis.disconnect();
      await new Promise((r) => setTimeout(r, 200)); // let pool sockets drain before DROP DATABASE
      execSync(`psql ${JSON.stringify(adminUrl.toString())} -c ${JSON.stringify(`DROP DATABASE ${dbName}`)}`, { stdio: 'pipe' });
    },
  };
}

/** OutboxDispatcher/JobSweeper take a Queue; each harness queue is namespaced per file. */
export type HarnessQueue = Queue;

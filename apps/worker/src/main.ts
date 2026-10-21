import { Queue } from 'bullmq';
import {
  loadEnv,
  createDb,
  runMigrations,
  migrations,
  createRedis,
  QUEUES,
  createLogger,
  setActiveCipher,
  createCipher,
  setReviewProviderResolver,
  dbReviewProvider,
} from '@forgepm/core';
import { OutboxDispatcher } from './dispatcher';
import { JobSweeper } from './sweeper';
import { RetentionJob } from './retention-job';
import { FactVerificationJob } from './fact-verification-job';
import { LocalFactFileSource } from './fact-file-source';
import { createDefaultWorker } from './handlers';

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);
  await runMigrations(db, migrations); // keep worker schema current on boot
  // Cipher for provider key decryption + the review provider resolver, so the
  // webhook-triggered Code Review resolves the org's ai_providers row (§10).
  setActiveCipher(createCipher(Buffer.from(env.FORGEPM_SECRET_KEY, 'base64')));
  setReviewProviderResolver((orgId) => dbReviewProvider(db, orgId));

  const log = createLogger(env.LOG_LEVEL, { component: 'worker' });
  const connection = createRedis(env.REDIS_URL);
  const redisUp = await redisReachable(connection);

  const retention = new RetentionJob(db, log);
  const factVerification = new FactVerificationJob(db, log, new LocalFactFileSource());
  retention.start();
  factVerification.start();

  // Queue-backed parts need Redis. Without it (e.g. a bare local run) the DB-only
  // jobs above still run and the API reports redis as unavailable on /health.
  let queue: Queue | undefined;
  let dispatcher: OutboxDispatcher | undefined;
  let sweeper: JobSweeper | undefined;
  let worker: ReturnType<typeof createDefaultWorker> | undefined;
  if (redisUp) {
    queue = new Queue(QUEUES.default, { connection });
    dispatcher = new OutboxDispatcher(db, queue, log);
    sweeper = new JobSweeper(db, queue, log);
    worker = createDefaultWorker(connection, db, log);
    dispatcher.start();
    sweeper.start();
    log.info('worker started (dispatcher + sweeper + retention + fact verification + default worker)');
  } else {
    connection.disconnect();
    log.warn('Redis unreachable: worker running in degraded mode (retention + fact verification only)');
  }

  const shutdown = async () => {
    dispatcher?.stop();
    sweeper?.stop();
    retention.stop();
    await factVerification.stop();
    await worker?.close();
    await queue?.close();
    await db.destroy();
    if (redisUp) connection.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function redisReachable(connection: ReturnType<typeof createRedis>): Promise<boolean> {
  connection.on('error', () => undefined); // reconnect noise; the probe result is what matters
  const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), 3000));
  return Promise.race([connection.ping().then((r) => r === 'PONG').catch(() => false), timeout]);
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});

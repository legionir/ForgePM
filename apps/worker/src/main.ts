import { Queue } from 'bullmq';
import {
  loadEnv,
  createDb,
  runMigrations,
  migrations,
  createRedis,
  QUEUES,
  createLogger,
} from '@forgepm/core';
import { OutboxDispatcher } from './dispatcher';
import { JobSweeper } from './sweeper';
import { createDefaultWorker } from './handlers';

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);
  await runMigrations(db, migrations); // keep worker schema current on boot

  const log = createLogger(env.LOG_LEVEL, { component: 'worker' });
  const connection = createRedis(env.REDIS_URL);
  const queue = new Queue(QUEUES.default, { connection });

  const dispatcher = new OutboxDispatcher(db, queue, log);
  const sweeper = new JobSweeper(db, queue, log);
  const worker = createDefaultWorker(connection, db, log);

  dispatcher.start();
  sweeper.start();
  log.info('worker started (dispatcher + sweeper + default worker)');

  const shutdown = async () => {
    dispatcher.stop();
    sweeper.stop();
    await worker.close();
    await queue.close();
    await db.destroy();
    connection.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});

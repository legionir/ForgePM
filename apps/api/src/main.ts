import { loadEnv, createDb, runMigrations, migrations, type Db } from '@forgepm/core';
import { buildApp } from './app/app';
import { buildRegistry, createHealthRedisProbe } from './app/modules';

async function main(): Promise<void> {
  const env = loadEnv();
  const db: Db = createDb(env.DATABASE_URL);

  // Forward-only migrations run at boot (plan §3b-4).
  await runMigrations(db, migrations);

  const registry = buildRegistry();
  const probe = createHealthRedisProbe(env.REDIS_URL);

  const app = await buildApp({ env, db, registry, redisAvailable: probe.available });
  await app.listen({ port: env.PORT, host: env.HOST });

  const shutdown = async () => {
    await app.close();
    await probe.close();
    await db.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});

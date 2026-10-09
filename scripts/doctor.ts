/**
 * pnpm doctor — environment self-check (plan §3 scripts list): validates env,
 * then probes Postgres and Redis and prints a PASS/FAIL line per dependency.
 */
import { loadEnv, createDb, createRedis, pingDb } from '../packages/core/src';

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);
  try {
    await pingDb(db);
    console.log('postgres: PASS');
  } catch (e) {
    console.log(`postgres: FAIL — ${(e as Error).message}`);
  } finally {
    await db.destroy();
  }

  const redis = createRedis(env.REDIS_URL);
  try {
    const pong = await redis.ping();
    console.log(pong === 'PONG' ? 'redis: PASS' : `redis: FAIL — unexpected reply ${pong}`);
  } catch (e) {
    console.log(`redis: FAIL — ${(e as Error).message}`);
  } finally {
    redis.disconnect();
  }
}

main().catch((e) => {
  process.stderr.write(`doctor: ${(e as Error).message}\n`);
  process.exit(1);
});

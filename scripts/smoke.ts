import { createDb, runMigrations, migrations, pingDb } from '../packages/core/src';

/**
 * npm run smoke — README-command smoke (§15): connects, runs migrations
 * (forward-only + idempotent), and pings. Used by CI on a clean clone.
 */
async function main(): Promise<void> {
  const db = createDb(process.env.DATABASE_URL ?? 'postgres://localhost:5432/forgepm');
  await runMigrations(db, migrations);
  await pingDb(db);
  console.log('smoke: OK (migrations applied, db reachable)');
  await db.destroy();
}

main().catch((e) => {
  process.stderr.write(`smoke: FAILED — ${(e as Error).message}\n`);
  process.exit(1);
});

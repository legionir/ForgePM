/**
 * npm run migrate — apply forward-only migrations. Needs only DATABASE_URL
 * (runs without the full runtime env so it works in CI/bootstrap).
 */
import { createDb, runMigrations, migrations } from '../packages/core/src';

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('migrate: DATABASE_URL is required\n');
  process.exit(1);
}

const db = createDb(url);
runMigrations(db, migrations)
  .then(() => db.destroy())
  .then(() => console.log('migrate: up to date'))
  .catch(async (e) => {
    await db.destroy().catch(() => undefined);
    process.stderr.write(`migrate: FAILED — ${(e as Error).message}\n`);
    process.exit(1);
  });

// Boot an embedded PostgreSQL for the local E2E/visual/integration runs (this
// sandbox has no system postgres). Not used by CI — CI gets Postgres from a
// service container — and never needs Docker (D-001/D-042).
//
// Re-runnable by design: `initialise()` refuses to touch a non-empty data
// directory, so a second run (same day, next phase, another machine) used to
// crash with "initdb: directory exists but is not empty" while the first run's
// cluster was still perfectly good. That made the DB gates look flaky for no
// reason, which is exactly how a gate gets skipped.
import { existsSync } from 'node:fs';
import EmbeddedPostgres from 'embedded-postgres';

const dataDir = process.env.FORGEPM_PGDATA || '/tmp/pgdata-e2e';
const port = Number(process.env.FORGEPM_PGPORT || 5433);
const databases = (process.env.FORGEPM_PGDBS || 'forgepm_e2e')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: true,
  onError: (msgOrErr) => console.error('[pg]', String(msgOrErr).slice(0, 400)),
});

const freshCluster = !existsSync(`${dataDir}/PG_VERSION`);
if (freshCluster) await pg.initialise();
await pg.start();
for (const name of databases) {
  try {
    await pg.createDatabase(name);
  } catch {
    // already exists — a persistent cluster survives across runs
  }
}
console.log(`POSTGRES READY on ${port} (${databases.join(', ')})${freshCluster ? ' — initialised' : ''}`);
// keep the process alive (globals: setInterval is declared readonly in eslint.config.mjs)
setInterval(() => {}, 60_000);

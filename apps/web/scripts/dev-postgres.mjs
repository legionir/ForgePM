// Boot an embedded PostgreSQL for the local E2E/visual runs (sandbox has no
// system postgres). Not committed to CI paths — CI uses real Postgres via
// apps/web/e2e.sh.
import EmbeddedPostgres from 'embedded-postgres';

const pg = new EmbeddedPostgres({
  databaseDir: '/tmp/pgdata-e2e',
  user: 'postgres',
  password: 'postgres',
  port: 5433,
  persistent: true,
  onError: (msgOrErr) => console.error('[pg]', String(msgOrErr).slice(0, 400)),
});

await pg.initialise();
await pg.start();
try {
  await pg.createDatabase('forgepm_e2e');
} catch {
  console.log('db forgepm_e2e already exists');
}
console.log('POSTGRES READY on 5433 (forgepm_e2e)');
// keep the process alive (globals: setInterval is declared readonly in eslint.config.mjs)
setInterval(() => {}, 60_000);

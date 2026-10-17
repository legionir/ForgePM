#!/usr/bin/env node
// apps/web/scripts/e2e-db.mjs — recreate the throwaway E2E database.
//
// e2e.sh used to do this by shelling out to `psql`, which is not a dependency of this
// repository: the Postgres apps/web can boot itself (@embedded-postgres) ships only server
// binaries, so `bash apps/web/e2e.sh` died on its third line wherever a client had not been
// installed by other means — the gate was effectively runnable only on machines someone had
// apt-installed postgresql-client on. Same argument as D-043/D-048: a gate that depends on the
// machine is not a gate. `pg` is already a dependency of @forgepm/api, so resolve it from there.
//
// Env: DATABASE_URL — a database on the target server (the maintenance database is fine).
//      E2E_DB — the database to recreate (default forgepm_e2e), same as e2e.sh.
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const { Client } = require('pg');

const dbName = process.env.E2E_DB ?? 'forgepm_e2e';
if (!/^[a-z_][a-z0-9_]*$/.test(dbName)) {
  process.stderr.write(`e2e-db: refusing suspicious database name ${JSON.stringify(dbName)}\n`);
  process.exit(2);
}
const url = new URL(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres');
url.pathname = '/postgres';

const admin = new Client({ connectionString: url.toString() });
await admin.connect();
try {
  // FORCE (PG13+) terminates backends still holding the database, which removes the race with
  // a previous run's pooled connections — without it the DROP blocks or errors, and the error
  // reads like "postgres is broken" rather than "the last run has not drained yet".
  for (let attempt = 1; ; attempt++) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      break;
    } catch (err) {
      if (attempt >= 3 || !/being accessed by other users|is being accessed/i.test(String(err))) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await admin.query(`CREATE DATABASE "${dbName}"`);
} finally {
  await admin.end();
}
process.stdout.write(`e2e-db: recreated ${dbName}\n`);

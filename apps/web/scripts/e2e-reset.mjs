#!/usr/bin/env node
// apps/web/scripts/e2e-reset.mjs — truncate every public table except the
// Kysely migration bookkeeping (same policy as tests/integration/harness.ts),
// so each spec file starts from a brand-new install (the §11 chain begins at
// first-run setup). Called between Playwright runs by e2e.sh. Pure node (pg
// via the api workspace) — no psql binary required.
import { createRequire } from 'node:module';

const require = createRequire('/home/user/ForgePM/apps/api/package.json');
const { Client } = require('pg');

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/forgepm_e2e';
const client = new Client({ connectionString: BASE_URL });
await client.connect();
const tables = (
  await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE 'kysely_%'",
  )
).rows.map((r) => r.tablename);
if (tables.length > 0) {
  await client.query(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} CASCADE`);
}
await client.end();
process.stdout.write(`e2e-reset: truncated ${tables.length} tables\n`);

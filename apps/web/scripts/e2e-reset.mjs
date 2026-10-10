#!/usr/bin/env node
// apps/web/scripts/e2e-reset.mjs — truncate every public table except the
// Kysely migration bookkeeping (same policy as tests/integration/harness.ts),
// so each spec file starts from a brand-new install (the §11 chain begins at
// first-run setup). Called between Playwright runs by e2e.sh.
import { execSync } from 'node:child_process';

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/forgepm_e2e';
const tables = execSync(
  `psql ${JSON.stringify(BASE_URL)} -Atc "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE 'kysely_%'"`,
)
  .toString()
  .trim()
  .split('\n')
  .filter(Boolean);
if (tables.length > 0) {
  execSync(`psql ${JSON.stringify(BASE_URL)} -qc "TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} CASCADE"`);
}
process.stdout.write(`e2e-reset: truncated ${tables.length} tables\n`);

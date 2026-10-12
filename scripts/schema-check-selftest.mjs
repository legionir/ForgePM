// scripts/schema-check-selftest.mjs
// Acceptance §15: "npm run schema:check ... با اختلاف عمدی خطا می‌دهد" — prove the
// checker actually fails on a deliberate mismatch instead of silently passing.
// We run schema:check against a scratch database where we DROP one contract
// index, expect a non-zero exit, then verify a correct DB exits 0.
import { execSync } from 'node:child_process';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('selftest: DATABASE_URL required');
  process.exit(1);
}

function psql(sql) {
  execSync(`psql ${JSON.stringify(url)} -q -c ${JSON.stringify(sql)}`, { stdio: 'pipe' });
}

try {
  // 1. good schema → schema:check exits 0
  execSync('npm run schema:check', { stdio: 'inherit', env: process.env });

  // 2. drop a required contract index → schema:check must exit non-zero
  psql('DROP INDEX IF EXISTS outbox_pending_idx;');
  let failed = false;
  try {
    execSync('npm run schema:check', { stdio: 'pipe', env: process.env });
  } catch {
    failed = true;
  }
  if (!failed) {
    console.error('selftest FAILED: schema:check passed despite a deliberate diff');
    process.exit(1);
  }

  // 3. restore → green again (DB left usable)
  psql('CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox (dispatched_at NULLS FIRST, created_at);');
  execSync('npm run schema:check', { stdio: 'pipe', env: process.env });

  console.log('schema-check selftest OK (deliberate diff correctly fails)');
} catch (e) {
  console.error(`selftest error: ${e.message ?? e}`);
  process.exit(1);
}

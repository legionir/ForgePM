// scripts/check-migration-hashes.mjs
// Migrations are forward-only: a migration that has already been merged to
// main must never be edited (plan §2, §3b-4). This compares the SHA-256 of
// every migration file against a committed manifest; a mismatch fails CI.
//
// Workflow: when a NEW migration is added, run `node scripts/check-migration-
// hashes.mjs --update` to record it (that is the only accepted change), commit
// the updated manifest. Editing an EXISTING entry's file then fails CI.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'core', 'src', 'db', 'migrations');
const manifestPath = join(dir, 'manifest.sha256.json');
const update = process.argv.includes('--update');

const files = readdirSync(dir).filter((f) => f.endsWith('.migration.ts')).sort();
const current = {};
for (const f of files) {
  current[f] = createHash('sha256').update(readFileSync(join(dir, f))).digest('hex');
}

if (update) {
  writeFileSync(manifestPath, JSON.stringify(current, null, 2) + '\n');
  console.log(`migration-hashes: recorded ${files.length} migration(s)`);
  process.exit(0);
}

if (!existsSync(manifestPath)) {
  console.error('migration-hashes: manifest missing — run with --update after adding migrations');
  process.exit(1);
}
const committed = JSON.parse(readFileSync(manifestPath, 'utf8'));
const problems = [];

for (const f of files) {
  if (committed[f] && committed[f] !== current[f]) {
    problems.push(`merged migration edited: ${f}`);
  }
}
for (const f of Object.keys(committed)) {
  if (!current[f]) problems.push(`merged migration deleted: ${f}`);
}

if (problems.length) {
  console.error(`migration-hashes FAILED:\n${problems.map((p) => '  - ' + p).join('\n')}`);
  process.exit(1);
}
console.log(`migration-hashes OK — ${files.length} migration(s), no merged file modified`);

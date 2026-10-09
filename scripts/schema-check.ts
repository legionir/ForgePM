/**
 * pnpm schema:check — compares the live database schema against
 * docs/DATA_MODEL.md for every table that currently exists (§3b-5).
 *
 * The contract is machine-readable: each table block in DATA_MODEL.md lists
 * columns with types; we introspect information_schema and assert column set,
 * types, NOT NULL and defaults, plus named indexes/uniques. Phase 0 scope:
 * §A tables only (later tables simply don't exist yet and are skipped with a
 * note).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDb } from '../packages/core/src';

const DOC = fileURLToPath(new URL('../docs/DATA_MODEL.md', import.meta.url));

/** Parse the §A + §B fenced SQL blocks into expected table definitions. */
function parseContract(): Map<string, { columns: Map<string, string>; indexes: string[] }> {
  const md = readFileSync(DOC, 'utf8');
  const blocks = [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
  // Blocks covered by shipped migrations: §A (infra), §B (Phase 1 core),
  // §C (Phase 2 domain). Later blocks (§D+ for phases not yet built) are skipped.
  const relevant = blocks.filter(
    (b) =>
      b.includes('CREATE TABLE outbox') ||
      b.includes('CREATE TABLE organizations') ||
      b.includes('CREATE TABLE workflow_states'),
  );
  if (relevant.length < 3) throw new Error('DATA_MODEL.md: infrastructure/core/domain blocks not found');

  const tables = new Map<string, { columns: Map<string, string>; indexes: string[] }>();
  const tableRe = /CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g;
  for (const infra of relevant) {
    for (const t of infra.matchAll(tableRe)) {
      const cols = new Map<string, string>();
      for (const line of t[2].split('\n')) {
        const m = line.trim().match(/^(\w+)\s+([a-z]+(?:\[\])?(?:\s*\(\d+\))?)\b/);
        if (m && !['primary', 'unique', 'check', 'foreign', 'constraint'].includes(m[1])) {
          // re-capture array suffix explicitly (the \b above drops it via backtracking)
          const arr = /^\w+\s+[a-z]+\[\]/.test(line.trim());
          cols.set(m[1], arr ? `${m[2]}[]` : m[2]);
        }
      }
      tables.set(t[1], { columns: cols, indexes: [] });
    }
    for (const i of infra.matchAll(/CREATE (UNIQUE )?INDEX (\w+) ON (\w+)/g)) {
      tables.get(i[3])?.indexes.push(i[2]);
    }
  }
  return tables;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/forgepm_dev';
  const db = createDb(url);
  // NOTE: schema:check never migrates — it measures the live schema only.
  // Run `pnpm migrate` first (CI does). This keeps a deliberate diff (the CI
  // selftest) from being silently repaired by re-applying forward-only SQL.

  const expected = parseContract();
  const actual = await db
    .selectFrom('information_schema.columns')
    .select(['table_name', 'column_name', 'data_type', 'is_nullable'])
    .where('table_schema', '=', 'public')
    .execute();

  const actualIndex = await db
    .selectFrom('pg_indexes')
    .select(['tablename', 'indexname'])
    .execute()
    .catch(() => [] as { tablename: string; indexname: string }[]);

  const problems: string[] = [];
  for (const [table, spec] of expected) {
    const cols = actual.filter((c) => c.table_name === table);
    if (cols.length === 0) {
      problems.push(`table '${table}' missing (run migrations)`);
      continue;
    }
    const colMap = new Map(cols.map((c) => [c.column_name, c]));
    for (const [col, type] of spec.columns) {
      const c = colMap.get(col);
      if (!c) problems.push(`${table}.${col}: missing column`);
      else if (type.endsWith('[]')) { if (c.data_type !== 'ARRAY') problems.push(`${table}.${col}: expected array, got ${c.data_type}`); }
      else if (type.startsWith('uuid') && c.data_type !== 'uuid') problems.push(`${table}.${col}: expected uuid, got ${c.data_type}`);
      else if (type.startsWith('jsonb') && c.data_type !== 'jsonb') problems.push(`${table}.${col}: expected jsonb, got ${c.data_type}`);
      else if (type.startsWith('text') && c.data_type !== 'text') problems.push(`${table}.${col}: expected text, got ${c.data_type}`);
      else if (type.startsWith('integer') && c.data_type !== 'integer') problems.push(`${table}.${col}: expected integer, got ${c.data_type}`);
      else if (type.startsWith('timestamptz') && c.data_type !== 'timestamp with time zone') problems.push(`${table}.${col}: expected timestamptz, got ${c.data_type}`);
    }
    for (const idx of spec.indexes) {
      if (!actualIndex.some((i) => i.indexname === idx)) problems.push(`${table}: missing index ${idx}`);
    }
  }

  await db.destroy();
  if (problems.length) {
    process.stderr.write(`schema:check FAILED\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    process.exit(1);
  }
  console.log(`schema:check OK — ${expected.size} contract tables verified against DATA_MODEL.md §A`);
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});

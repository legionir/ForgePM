import { createDb, runMigrations, migrations, upsertSetting, getEffective } from '../packages/core/src';

/**
 * npm run seed — Phase 0 seed: register the sample module as disabled by default
 * (the row the registry guard reads). Domain seed (default org, admin bootstrap)
 * lands in Phase 1. Also seeds the non-sensitive execution-control defaults for a
 * development install. Idempotent: a value someone already set is never replaced.
 *
 * Deliberately NOT seeded (secrets/endpoints, set by a human in the panel):
 * `exec.ci_log_endpoint`, `exec.ci_log_secret_name` and the CI token itself.
 */

/** The repository's own source directories — read-only review roots (prefix-safe, no globs). */
const DEV_EXEC_DEFAULTS: Record<string, unknown> = {
  'exec.allowed_repo_roots': ['apps', 'packages', 'tests', 'scripts', 'docs'],
};

async function main(): Promise<void> {
  const db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/forgepm_dev');
  await runMigrations(db, migrations);

  const cur = await getEffective(db, 'modules.sample.enabled', null, null);
  if (!cur) await upsertSetting(db, 'system', null, 'modules.sample.enabled', false);

  for (const [key, value] of Object.entries(DEV_EXEC_DEFAULTS)) {
    if (!(await getEffective(db, key, null, null))) await upsertSetting(db, 'system', null, key, value);
  }

  console.log('seed: OK (Phase 0 infra defaults in place)');
  await db.destroy();
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
});

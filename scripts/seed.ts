import { createDb, runMigrations, migrations, upsertSetting, getEffective } from '../packages/core/src';

/**
 * npm run seed — Phase 0 seed: register the sample module as disabled by default
 * (the row the registry guard reads). Domain seed (default org, admin bootstrap)
 * lands in Phase 1. Idempotent.
 */
async function main(): Promise<void> {
  const db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/forgepm_dev');
  await runMigrations(db, migrations);

  const cur = await getEffective(db, 'modules.sample.enabled', null, null);
  if (!cur) await upsertSetting(db, 'system', null, 'modules.sample.enabled', false);

  console.log('seed: OK (Phase 0 infra defaults in place)');
  await db.destroy();
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
});

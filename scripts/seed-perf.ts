#!/usr/bin/env tsx
/**
 * pnpm seed:perf — the PERFORMANCE_BUDGET.md seed dataset (plan §5.10, behind
 * a flag): N projects; one BIG project and the rest sharing OTHER_ITEMS.
 * Bulk INSERT ... SELECT (synthetic measurement data, not a product mutation —
 * so it bypasses the service layer by design). Keys are 3-letter base-26 codes
 * to satisfy projects.key CHECK '^[A-Z]{3,5}$' while staying unique per org.
 * Idempotent: refuses to double-seed.
 *
 *   DATABASE_URL=... pnpm seed:perf
 *
 * Env: PERF_PROJECTS (default 10000), PERF_BIG_ITEMS (200000),
 * PERF_OTHER_ITEMS (300000).
 */
import { performance } from 'node:perf_hooks';
import { sql } from 'kysely';
import { createDb, runMigrations, migrations, newId, generateApiKey, type Db } from '@forgepm/core';
import { hashPassword } from '../apps/api/src/modules/auth/service';

const PROJECTS = Number(process.env.PERF_PROJECTS ?? 10_000);
const BIG_ITEMS = Number(process.env.PERF_BIG_ITEMS ?? 200_000);
const OTHER_ITEMS = Number(process.env.PERF_OTHER_ITEMS ?? 300_000);

async function main(): Promise<void> {
  const db: Db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/forgepm_perf');
  await runMigrations(db, migrations);

  const seeded = await sql<{ c: string }>`SELECT count(*)::text c FROM projects`.execute(db);
  if (Number(seeded.rows[0].c) >= PROJECTS) {
    console.log('seed:perf: already seeded — skipping');
    await db.destroy();
    return;
  }

  const t0 = performance.now();
  const orgId = newId();
  await sql`
    INSERT INTO organizations (id, name, slug) VALUES (${orgId}, 'Perf Org', ${'perf-' + orgId.slice(0, 8)})
  `.execute(db);

  // 1) projects — base-26 3-letter keys (A00..ZZZ range covers 10k+) via the
  // alphabet mapped over the series index; UNIQUE(org,key) holds.
  await sql`
    INSERT INTO projects (id, organization_id, key, name, status, next_item_number)
    SELECT gen_random_uuid(), ${orgId},
           chr(65 + (g / 676) % 26) || chr(65 + (g / 26) % 26) || chr(65 + g % 26),
           'Perf Project ' || g, 'active', 1
    FROM generate_series(1, ${PROJECTS}) g
  `.execute(db);

  // 2) default workflow for every project.
  await sql`
    INSERT INTO workflow_states (id, organization_id, project_id, name, category, position)
    SELECT gen_random_uuid(), p.organization_id, p.id, w.name, w.category, w.pos
    FROM projects p
    CROSS JOIN (VALUES
      ('Backlog','backlog',0),('Todo','unstarted',1),('In Progress','started',2),
      ('In Review','in_review',3),('Done','completed',4),('Canceled','canceled',5)
    ) AS w(name, category, pos)
  `.execute(db);
  console.log(`seed:perf: ${PROJECTS} projects + workflows in ${Math.round(performance.now() - t0)}ms`);

  // 3) the BIG project = the first created project (lowest key). Alternate
  // backlog/completed states; search_vector is a GENERATED column (not inserted).
  const big = await db.selectFrom('projects').select(['id', 'organization_id']).orderBy('key').executeTakeFirstOrThrow();
  await sql`
    INSERT INTO work_items (id, organization_id, project_id, number, type, title, description,
                            state_id, priority, source, acceptance_criteria, created_at, updated_at)
    SELECT gen_random_uuid(), ${orgId}, ${big.id}, g,
           (ARRAY['task','bug','improvement','chore'])[1 + g % 4],
           'Perf item ' || g || ' of the big project',
           'Bulk measurement row number ' || g || ' with searchable text alpha' || (g % 97) || ' beta gamma',
           st.id,
           (ARRAY['none','low','medium','high','urgent'])[1 + g % 5],
           'manual', '[]'::jsonb,
           -- the big project is the ACTIVE one: its 200k items spread over the
           -- last day, so the cursor scan of recent rows lands on it directly.
           now() - (random() * interval '1 day'), now()
    FROM generate_series(1, ${BIG_ITEMS}) g
    CROSS JOIN LATERAL (
      SELECT id FROM workflow_states
      WHERE project_id = ${big.id} AND category IN ('backlog','completed')
      ORDER BY position OFFSET (g % 2) LIMIT 1
    ) st
  `.execute(db);
  // keep the counter ahead of the seeded range for future items.
  await db.updateTable('projects').set({ next_item_number: BIG_ITEMS + 1 }).where('id', '=', big.id).execute();
  console.log(`seed:perf: big project ${BIG_ITEMS} items in ${Math.round(performance.now() - t0)}ms`);

  // 4) remaining projects share OTHER_ITEMS, numbered 1..k per project.
  const perProject = Math.ceil(OTHER_ITEMS / (PROJECTS - 1));
  await sql`
    INSERT INTO work_items (id, organization_id, project_id, number, type, title, description,
                            state_id, priority, source, acceptance_criteria, created_at, updated_at)
    SELECT gen_random_uuid(), ${orgId}, p.id, g.n, 'task',
           'Perf item ' || g.n, 'row ' || g.n,
           (SELECT id FROM workflow_states ws WHERE ws.project_id = p.id AND ws.category = 'backlog' LIMIT 1),
           'medium', 'manual', '[]'::jsonb,
           -- background projects are historical: spread over the past year so
           -- the org-wide cursor (created_at DESC) starts on the big ACTIVE
           -- project instead of scanning thousands of identical-time rows first.
           now() - (random() * interval '365 days'), now()
    FROM projects p
    CROSS JOIN LATERAL generate_series(1, ${perProject}) AS g(n)
    WHERE p.id <> ${big.id}
  `.execute(db);
  await sql`UPDATE projects SET next_item_number = ${perProject + 1} WHERE id <> ${big.id}`.execute(db);

  const total = await sql<{ c: string }>`SELECT count(*)::text c FROM work_items`.execute(db);
  // bulk INSERT ... SELECT leaves stale planner statistics; ANALYZE so the
  // load gates (pnpm perf) plan against real distributions, exactly as a
  // night's autovacuum analyze would in production.
  await sql`ANALYZE`.execute(db);
  console.log(`seed:perf: done in ${Math.round(performance.now() - t0)}ms — ${total.rows[0].c} work items (analyzed)`);

  // 5) a loginable admin (argon2id, real hash) + an admin-owned read/write API
  // key so `pnpm perf` (autocannon) and the P-05 Playwright first-paint gate
  // can drive authenticated endpoints. Test-only dataset — this DB never
  // holds real credentials, and the password is a fixed seed constant.
  const perfUserId = newId();
  await db
    .insertInto('users')
    .values({
      id: perfUserId,
      email: 'perf@seed.local',
      password_hash: await hashPassword(process.env.PERF_PASSWORD ?? 'perf-password-1'),
      display_name: 'Perf Runner',
    })
    .execute();
  await db
    .insertInto('memberships')
    .values({ id: newId(), organization_id: orgId, user_id: perfUserId, role: 'admin' })
    .execute();
  const ak = generateApiKey();
  await sql`
    INSERT INTO api_keys (id, organization_id, owner_user_id, agent_id, key_hash, prefix, name, scopes)
    VALUES (${newId()}, ${orgId}, ${perfUserId}, NULL, ${ak.key_hash}, ${ak.prefix}, 'perf-runner', ARRAY['read','write'])
  `.execute(db);
  console.log(`seed:perf: PERF_API_KEY=${ak.raw}`);
  await db.destroy();
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).stack ?? (e as Error).message}\n`);
  process.exit(1);
});

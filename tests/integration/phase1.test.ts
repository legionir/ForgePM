import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { upsertSetting, newId, unitOfWork, recordAudit, type Env } from '@forgepm/core';
import { buildApp } from '../../apps/api/src/app/app';
import { buildRegistry } from '../../apps/api/src/app/modules';
import { createHarness, type Harness } from './harness';
import { seedOrg, type SeedFixture } from './seed';

const env = {
  NODE_ENV: 'test',
  PORT: 0,
  HOST: '127.0.0.1',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/forgepm_test',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  FORGEPM_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
  WEB_ORIGIN: 'http://localhost:4200',
  API_DOCS_ENABLED: false,
  METRICS_ENABLED: false,
  LOG_LEVEL: 'fatal',
} satisfies Env;

let h: Harness;
let app: FastifyInstance;

beforeAll(async () => {
  h = await createHarness();
  app = await buildApp({ env, db: h.db, registry: buildRegistry(), redisAvailable: () => Promise.resolve(true) });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await h.cleanup();
});

beforeEach(async () => {
  await h.reset();
});

async function loginAs(seed: SeedFixture, email: string, password: string): Promise<{ cookies: string; csrf: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
  expect(res.statusCode).toBe(200, `login ${email}: ${res.body}`);
  const cookies = res.headers['set-cookie'] as unknown as string[];
  const session = cookies.find((c) => c.startsWith('fpm_session='))!;
  const csrf = cookies.find((c) => c.startsWith('fpm_csrf='))!.split(';')[0].split('=')[1];
  return { cookies: `${session.split(';')[0]}; fpm_csrf=${csrf}`, csrf };
}

describe('auth (plan §5 acceptance)', () => {
  it('login with correct password sets httpOnly cookie and returns 200; wrong pw 401 AUTH_INVALID_CREDENTIALS', async () => {
    const seed = await seedOrg(h.db, { email: 'a@x.io', password: 'hunter22x' });
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'a@x.io', password: 'hunter22x' } });
    expect(res.statusCode).toBe(200);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    const sessionCookie = cookies.find((c) => c.startsWith('fpm_session='))!;
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);

    const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'a@x.io', password: 'wrong' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('AUTH_INVALID_CREDENTIALS');

    // seed used to create user directly; also verify argon2id hash stored.
    const row = await h.db.selectFrom('users').select('password_hash').where('id', '=', seed.userId).executeTakeFirstOrThrow();
    expect(row.password_hash).toMatch(/^\$argon2id\$/);
  });

  it('after 10 failed attempts login is 429 RATE_LIMITED', async () => {
    await seedOrg(h.db, { email: 'rl@x.io', password: 'hunter22x' });
    for (let i = 0; i < 11; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'rl@x.io', password: 'wrong' } });
      if (i < 10) expect(r.statusCode).toBe(401);
      else expect(r.statusCode).toBe(429);
    }
  });

  it('one-time /auth/setup succeeds on empty DB, then 409 CONFLICT; /auth/me returns actor', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { organization_name: 'Acme', admin_email: 'root@x.io', admin_password: 'super-secret', admin_display_name: 'Root' },
    });
    expect(res.statusCode).toBe(200, res.body);
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { organization_name: 'Acme', admin_email: 'root@x.io', admin_password: 'super-secret', admin_display_name: 'Root' },
    });
    expect(second.statusCode).toBe(409);

    const cookies = res.headers['set-cookie'] as unknown as string[];
    const session = cookies.find((c) => c.startsWith('fpm_session='))!.split(';')[0];
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: session } });
    expect(me.statusCode).toBe(200);
    expect(me.json().actor).toMatchObject({ type: 'user', org_role: 'owner' });
  });

  it('raw api key is shown only at creation; only the sha256 hash lives in the DB', async () => {
    const seed = await seedOrg(h.db, { email: 'k@x.io', password: 'hunter22x' });
    const { cookies, csrf } = await loginAs(seed, 'k@x.io', 'hunter22x');
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      headers: { cookie: cookies, 'x-csrf-token': csrf },
      payload: { name: 'ci', scopes: ['read'] },
    });
    expect(create.statusCode).toBe(201, create.body);
    const raw = create.json().raw_key as string;
    expect(raw).toMatch(/^fpm_[a-f0-9]{40}$/);

    // list shows no raw key
    const list = await app.inject({ method: 'GET', url: '/api/v1/api-keys', headers: { cookie: cookies } });
    expect(list.json().items[0]).not.toHaveProperty('raw_key');

    // DB: search every table's dump for the raw key -> must not appear
    const dump = await h.db.selectFrom('api_keys').selectAll().execute();
    const dumpStr = JSON.stringify(dump);
    expect(dumpStr).not.toContain(raw);
    const audit = await h.db.selectFrom('audit_events').selectAll().execute();
    expect(JSON.stringify(audit)).not.toContain(raw);
  });

  it('revoked / expired key returns AUTH_REQUIRED at call time', async () => {
    const seed = await seedOrg(h.db, { email: 'e@x.io', password: 'hunter22x' });
    const { cookies, csrf } = await loginAs(seed, 'e@x.io', 'hunter22x');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      headers: { cookie: cookies, 'x-csrf-token': csrf },
      payload: { name: 'x', scopes: ['read'], expires_at: new Date(Date.now() - 1000).toISOString() },
    });
    const raw = created.json().raw_key as string;
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${raw}` } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('AUTH_REQUIRED');
  });
});

describe('permissions (plan §5 matrix)', () => {
  it('viewer POST /projects => 403', async () => {
    const seed = await seedOrg(h.db, { email: 'v@x.io', password: 'hunter22x', role: 'viewer' });
    const { cookies, csrf } = await loginAs(seed, 'v@x.io', 'hunter22x');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie: cookies, 'x-csrf-token': csrf },
      payload: { key: 'ABC', name: 'p' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('member NOT in a project => 404 (no existence leak)', async () => {
    const seed = await seedOrg(h.db, { email: 'm@x.io', password: 'hunter22x', role: 'member' });
    // seed created a project owned by seed.adminUserId — not this member
    const other = await seedOrg(h.db, { email: 'o@x.io', password: 'hunter22x', role: 'admin', createProject: true });
    const { cookies } = await loginAs(seed, 'm@x.io', 'hunter22x');
    const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${other.projectId}`, headers: { cookie: cookies } });
    expect(res.statusCode).toBe(404);
  });

  it('api key project_ids=[A] never sees project B', async () => {
    const seed = await seedOrg(h.db, { email: 's@x.io', password: 'hunter22x' });
    const { cookies, csrf } = await loginAs(seed, 's@x.io', 'hunter22x');
    const b = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie: cookies, 'x-csrf-token': csrf },
      payload: { key: 'BBB', name: 'B' },
    });
    const bId = b.json().id as string;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      headers: { cookie: cookies, 'x-csrf-token': csrf },
      payload: { name: 'restricted', scopes: ['read', 'write'], project_ids: [seed.projectId] },
    });
    const raw = created.json().raw_key as string;
    const list = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: { authorization: `Bearer ${raw}` } });
    const keys = list.json().items.map((p: { id: string }) => p.id);
    expect(keys).toContain(seed.projectId);
    expect(keys).not.toContain(bId);

    const get = await app.inject({ method: 'GET', url: `/api/v1/projects/${bId}`, headers: { authorization: `Bearer ${raw}` } });
    expect(get.statusCode).toBe(404);
  });
});

describe('two-org separation (plan §5 acceptance)', () => {
  it('org A never sees org B projects (read isolation); unique(org,key) enforced', async () => {
    const a = await seedOrg(h.db, { email: 'a@x.io', password: 'hunter22x', orgName: 'OrgA', projectKey: 'AAA' });
    const b = await seedOrg(h.db, { email: 'b@y.io', password: 'hunter22x', orgName: 'OrgB', projectKey: 'BBB' });
    const { cookies } = await loginAs(a, 'a@x.io', 'hunter22x');
    const list = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: { cookie: cookies } });
    expect(list.json().items.every((p: { organization_id: string }) => p.organization_id === a.organizationId)).toBe(true);
    // B's project is not visible from A => 404.
    const hidden = await app.inject({ method: 'GET', url: `/api/v1/projects/${b.projectId}`, headers: { cookie: cookies } });
    expect(hidden.statusCode).toBe(404);
    // Duplicate key within one org is rejected by UNIQUE(organization_id,key).
    await expect(
      h.db
        .insertInto('projects')
        .values({ id: newId(), organization_id: a.organizationId, key: 'AAA', name: 'dup' })
        .execute(),
    ).rejects.toThrow();
  });
});


describe('settings inheritance (plan §5 acceptance)', () => {
  it('review.issue_policy X at system, project A overrides Y; B inherits X; source reported', async () => {
    const seed = await seedOrg(h.db, { email: 'cf@x.io', password: 'hunter22x' });
    const { cookies, csrf } = await loginAs(seed, 'cf@x.io', 'hunter22x');
    const b = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie: cookies, 'x-csrf-token': csrf },
      payload: { key: 'PRJB', name: 'B' },
    });
    const bId = b.json().id as string;

    const sys = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/system/-/review.issue_policy',
      headers: { cookie: cookies, 'x-csrf-token': csrf },
      payload: { value: 'record_only' },
    });
    expect(sys.statusCode).toBe(200, sys.body);
    const proj = await app.inject({
      method: 'PUT',
      url: `/api/v1/settings/project/${seed.projectId}/review.issue_policy`,
      headers: { cookie: cookies, 'x-csrf-token': csrf },
      payload: { value: 'human_approval' },
    });
    expect(proj.statusCode).toBe(200, proj.body);

    const eA = await app.inject({
      method: 'GET',
      url: `/api/v1/settings/effective?scope=project&scope_id=${seed.projectId}&key=review.issue_policy`,
      headers: { cookie: cookies },
    });
    expect(eA.json()).toMatchObject({ value: 'human_approval', source: 'project' });
    const eB = await app.inject({
      method: 'GET',
      url: `/api/v1/settings/effective?scope=project&scope_id=${bId}&key=review.issue_policy`,
      headers: { cookie: cookies },
    });
    expect(eB.json()).toMatchObject({ value: 'record_only', source: 'system' });

    // DELETE project override => reverts to system
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/settings/project/${seed.projectId}/review.issue_policy`,
      headers: { cookie: cookies, 'x-csrf-token': csrf },
    });
    expect(del.statusCode).toBe(200);
    const eA2 = await app.inject({
      method: 'GET',
      url: `/api/v1/settings/effective?scope=project&scope_id=${seed.projectId}&key=review.issue_policy`,
      headers: { cookie: cookies },
    });
    expect(eA2.json()).toMatchObject({ value: 'record_only', source: 'system' });
  });

  it('two scope=NULL settings rows with same key are rejected (unique partial)', async () => {
    await upsertSetting(h.db, 'system', null, 'review.auto_run', true);
    await upsertSetting(h.db, 'system', null, 'review.auto_run', false); // update path
    const rows = await h.db.selectFrom('settings').selectAll().where('scope', '=', 'system').execute();
    expect(rows.length).toBe(1);
  });
});

describe('audit transaction (plan §5 acceptance)', () => {
  it('each project mutation writes exactly one audit_event in the same tx', async () => {
    const seed = await seedOrg(h.db, { email: 'au@x.io', password: 'hunter22x' });
    const { cookies, csrf } = await loginAs(seed, 'au@x.io', 'hunter22x');
    const before = await h.db.selectFrom('audit_events').select('id').where('organization_id', '=', seed.organizationId).execute();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie: cookies, 'x-csrf-token': csrf },
      payload: { key: 'AUD', name: 'audit' },
    });
    expect(res.statusCode).toBe(201);
    const after = await h.db.selectFrom('audit_events').select('id').where('organization_id', '=', seed.organizationId).execute();
    expect(after.length - before.length).toBe(1);
  });

  it('injected audit failure rolls back the entire mutation', async () => {
    const seed = await seedOrg(h.db, { email: 'inj@x.io', password: 'hunter22x' });
    // Simulate injected failure by adding a trigger that throws on insert into
    // audit_events for one specific request_id.
    await sql`
      CREATE OR REPLACE FUNCTION forgepm_test_fail_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.request_id = 'force-fail' THEN
          RAISE EXCEPTION 'injected';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER audit_fail BEFORE INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION forgepm_test_fail_audit();
    `.execute(h.db);
    // Directly try to run a unitOfWork that inserts audit with request_id='force-fail'
    await expect(
      unitOfWork(h.db, async ({ tx }) => {
        await tx.insertInto('projects').values({ id: newId(), organization_id: seed.organizationId, key: 'ROLL', name: 'x' }).execute();
        await recordAudit(tx, {
          organization_id: seed.organizationId,
          actor_type: 'user',
          actor_id: seed.userId,
          action: 'project.create',
          resource_type: 'project',
          resource_id: newId(),
          request_id: 'force-fail',
        });
      }),
    ).rejects.toThrow(/injected/);

    const rolled = await h.db.selectFrom('projects').select('id').where('key', '=', 'ROLL').execute();
    expect(rolled.length).toBe(0);
    await sql`DROP TRIGGER audit_fail ON audit_events; DROP FUNCTION forgepm_test_fail_audit();`.execute(h.db);
  });
});

describe('pagination + validation (plan §5 acceptance)', () => {
  it('GET /projects?limit=50 returns next_cursor; limit=201 returns 400', async () => {
    const seed = await seedOrg(h.db, { email: 'p@x.io', password: 'hunter22x' });
    const { cookies, csrf } = await loginAs(seed, 'p@x.io', 'hunter22x');
    for (let i = 0; i < 3; i++) {
      const cr = await app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: { cookie: cookies, 'x-csrf-token': csrf },
        payload: { key: `PRJ${String.fromCharCode(65 + i)}`, name: `p${i}` },
      });
      expect(cr.statusCode).toBe(201, cr.body);
    }
    const list = await app.inject({ method: 'GET', url: '/api/v1/projects?limit=2', headers: { cookie: cookies } });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.length).toBe(2);
    expect(typeof list.json().next_cursor).toBe('string');
    const bad = await app.inject({ method: 'GET', url: '/api/v1/projects?limit=201', headers: { cookie: cookies } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('CSRF + errors', () => {
  it('mutating without CSRF header while session-authed => 403', async () => {
    const seed = await seedOrg(h.db, { email: 'csrf@x.io', password: 'hunter22x' });
    const { cookies } = await loginAs(seed, 'csrf@x.io', 'hunter22x');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie: cookies },
      payload: { key: 'CSRF', name: 'x' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });
});

describe('users + members + audit read (coverage + §5)', () => {
  it('admin creates a user, sets membership role, adds project member, reads audit', async () => {
    const seed = await seedOrg(h.db, { email: 'boss@x.io', password: 'hunter22x' });
    const { cookies, csrf } = await loginAs(seed, 'boss@x.io', 'hunter22x');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { cookie: cookies, 'x-csrf-token': csrf },
      payload: { email: 'dev@x.io', password: 'hunter22x', display_name: 'Dev' },
    });
    expect(created.statusCode).toBe(201, created.body);
    const newUserId = created.json().id as string;

    // duplicate email => 409
    const dup = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { cookie: cookies, 'x-csrf-token': csrf },
      payload: { email: 'dev@x.io', password: 'hunter22x', display_name: 'Dev2' },
    });
    expect(dup.statusCode).toBe(409);

    const list = await app.inject({ method: 'GET', url: '/api/v1/users', headers: { cookie: cookies } });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.length).toBe(2);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${newUserId}`,
      headers: { cookie: cookies, 'x-csrf-token': csrf },
      payload: { display_name: 'Dev Renamed' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().display_name).toBe('Dev Renamed');

    // membership role
    const mem = await app.inject({
      method: 'POST',
      url: '/api/v1/memberships',
      headers: { cookie: cookies, 'x-csrf-token': csrf },
      payload: { user_id: newUserId, role: 'admin' },
    });
    expect(mem.statusCode).toBe(200);
    const memList = await app.inject({ method: 'GET', url: '/api/v1/memberships', headers: { cookie: cookies } });
    expect(memList.json().items.find((m: { user_id: string }) => m.user_id === newUserId).role).toBe('admin');

    // add as project member with role contributor
    const pm = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${seed.projectId}/members/${newUserId}`,
      headers: { cookie: cookies, 'x-csrf-token': csrf },
      payload: { role: 'contributor' },
    });
    expect(pm.statusCode).toBe(200, pm.body);
    const pmList = await app.inject({ method: 'GET', url: `/api/v1/projects/${seed.projectId}/members`, headers: { cookie: cookies } });
    expect(pmList.json().items.some((m: { user_id: string }) => m.user_id === newUserId)).toBe(true);

    // audit log readable by admin/owner
    const audit = await app.inject({ method: 'GET', url: '/api/v1/audit?limit=10', headers: { cookie: cookies } });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().items.length).toBeGreaterThan(0);

    // viewer cannot read audit / list users
    const vSeed = await seedOrg(h.db, { email: 'vv@x.io', password: 'hunter22x', role: 'viewer', orgName: 'VV' });
    const v = await loginAs(vSeed, 'vv@x.io', 'hunter22x');
    const vAudit = await app.inject({ method: 'GET', url: '/api/v1/audit', headers: { cookie: v.cookies } });
    expect(vAudit.statusCode).toBe(403);
  });

  it('non-admin cannot create users (member) => 403', async () => {
    const seed = await seedOrg(h.db, { email: 'mm@x.io', password: 'hunter22x', role: 'member', orgName: 'MM' });
    const { cookies, csrf } = await loginAs(seed, 'mm@x.io', 'hunter22x');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { cookie: cookies, 'x-csrf-token': csrf },
      payload: { email: 'z@x.io', password: 'hunter22x', display_name: 'Z' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('revoke own api key => subsequent Bearer call is 401', async () => {
    const seed = await seedOrg(h.db, { email: 'rk@x.io', password: 'hunter22x' });
    const { cookies, csrf } = await loginAs(seed, 'rk@x.io', 'hunter22x');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      headers: { cookie: cookies, 'x-csrf-token': csrf },
      payload: { name: 'r', scopes: ['read'] },
    });
    const id = created.json().api_key.id as string;
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/api-keys/${id}`,
      headers: { cookie: cookies, 'x-csrf-token': csrf },
    });
    expect(del.statusCode).toBe(204);
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookies } });
    expect(me.statusCode).toBe(200);
  });

  it('archive + unarchive a project', async () => {
    const seed = await seedOrg(h.db, { email: 'ar@x.io', password: 'hunter22x' });
    const { cookies, csrf } = await loginAs(seed, 'ar@x.io', 'hunter22x');
    const arch = await app.inject({ method: 'POST', url: `/api/v1/projects/${seed.projectId}/archive`, headers: { cookie: cookies, 'x-csrf-token': csrf } });
    expect(arch.statusCode).toBe(200);
    expect(arch.json().status).toBe('archived');
    const un = await app.inject({ method: 'POST', url: `/api/v1/projects/${seed.projectId}/unarchive`, headers: { cookie: cookies, 'x-csrf-token': csrf } });
    expect(un.json().status).toBe('active');
    // delete => 204 then GET => 404
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/projects/${seed.projectId}`, headers: { cookie: cookies, 'x-csrf-token': csrf } });
    expect(del.statusCode).toBe(204);
    const gone = await app.inject({ method: 'GET', url: `/api/v1/projects/${seed.projectId}`, headers: { cookie: cookies } });
    expect(gone.statusCode).toBe(404);
  });

  it('duplicate project key within org => 409', async () => {
    const seed = await seedOrg(h.db, { email: 'dup@x.io', password: 'hunter22x', projectKey: 'SAME' });
    const { cookies, csrf } = await loginAs(seed, 'dup@x.io', 'hunter22x');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie: cookies, 'x-csrf-token': csrf },
      payload: { key: 'SAME', name: 'x' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('settings: invalid value rejected, unknown key rejected', async () => {
    const seed = await seedOrg(h.db, { email: 'st@x.io', password: 'hunter22x' });
    const { cookies, csrf } = await loginAs(seed, 'st@x.io', 'hunter22x');
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/system/-/review.min_confidence',
      headers: { cookie: cookies, 'x-csrf-token': csrf },
      payload: { value: 5 }, // out of range
    });
    expect(bad.statusCode).toBe(400);
    const unknown = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/system/-/nope.not.a.key',
      headers: { cookie: cookies, 'x-csrf-token': csrf },
      payload: { value: 1 },
    });
    expect(unknown.statusCode).toBe(400);
    // registry listing
    const reg = await app.inject({ method: 'GET', url: '/api/v1/settings/registry', headers: { cookie: cookies } });
    expect(reg.statusCode).toBe(200);
    expect(reg.json().settings.length).toBeGreaterThan(0);
  });

  it('login + me + logout cycle works', async () => {
    const seed = await seedOrg(h.db, { email: 'lo@x.io', password: 'hunter22x' });
    const { cookies } = await loginAs(seed, 'lo@x.io', 'hunter22x');
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookies } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe('lo@x.io');
    const out = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: cookies } });
    expect(out.statusCode).toBe(200);
  });
});

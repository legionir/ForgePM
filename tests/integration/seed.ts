import { createCipher, generateApiKey, hashApiKey, newId, type Db } from '@forgepm/core';
import type { OrgRole } from '@forgepm/shared';
import { hashPassword } from '../../apps/api/src/modules/auth/service';

export interface SeedFixture {
  organizationId: string;
  userId: string;
  projectId: string;
}

/**
 * Deterministic test seeding: creates an org + owner (or given role) user +
 * an optional project. Reuses the real argon2id hashing so login works.
 */
export async function seedOrg(
  db: Db,
  opts: {
    email: string;
    password: string;
    role?: OrgRole;
    orgName?: string;
    createProject?: boolean; // default true
    projectKey?: string;
  },
): Promise<SeedFixture> {
  const organizationId = newId();
  const userId = newId();
  const passwordHash = await hashPassword(opts.password);
  await db
    .insertInto('organizations')
    .values({ id: organizationId, name: opts.orgName ?? 'Org', slug: `org-${organizationId}` })
    .execute();
  await db
    .insertInto('users')
    .values({ id: userId, email: opts.email.toLowerCase(), password_hash: passwordHash, display_name: opts.email })
    .execute();
  await db
    .insertInto('memberships')
    .values({ id: newId(), organization_id: organizationId, user_id: userId, role: opts.role ?? 'owner' })
    .execute();

  let projectId = '';
  if (opts.createProject !== false) {
    projectId = newId();
    await db
      .insertInto('projects')
      .values({ id: projectId, organization_id: organizationId, key: opts.projectKey ?? 'SEED', name: 'Seed Project' })
      .execute();
    await db
      .insertInto('project_members')
      .values({ id: newId(), project_id: projectId, user_id: userId, role: 'lead' })
      .execute();
  } else {
    projectId = '';
  }

  return { organizationId, userId, projectId };
}

/** Mint an API key row for a user; returns the raw key for use in requests. */
export async function seedApiKey(
  db: Db,
  organizationId: string,
  userId: string,
  scopes: string[],
  projectIds: string[] = [],
  opts: { agentId?: string } = {},
): Promise<string> {
  const raw = `fpm_${Buffer.from(cryptoRandomBytes(20)).toString('hex')}`;
  await db
    .insertInto('api_keys')
    .values({
      id: newId(),
      organization_id: organizationId,
      // An AGENT key has no owner: the schema says exactly one of the two.
      owner_user_id: opts.agentId ? null : userId,
      agent_id: opts.agentId ?? null,
      key_hash: hashApiKey(raw),
      prefix: raw.slice(0, 12),
      name: 'seed',
      scopes: scopes as never,
      project_ids: projectIds as never,
    })
    .execute();
  return raw;
}

/** An agent row, so a key can belong to an agent instead of a person. */
export async function seedAgent(db: Db, organizationId: string, name = 'seed-agent'): Promise<string> {
  const id = newId();
  await db
    .insertInto('agents')
    .values({ id, organization_id: organizationId, name, status: 'active' })
    .execute();
  return id;
}

/** Add another user (default role `member`) to an existing org. */
export async function seedMember(
  db: Db,
  organizationId: string,
  opts: { email: string; password: string; role?: OrgRole },
): Promise<string> {
  const userId = newId();
  await db
    .insertInto('users')
    .values({ id: userId, email: opts.email.toLowerCase(), password_hash: await hashPassword(opts.password), display_name: opts.email })
    .execute();
  await db
    .insertInto('memberships')
    .values({ id: newId(), organization_id: organizationId, user_id: userId, role: opts.role ?? 'member' })
    .execute();
  return userId;
}

function cryptoRandomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export { createCipher, generateApiKey };

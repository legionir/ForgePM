import argon2 from 'argon2';
import { createHash } from 'node:crypto';
import { AppError } from '@forgepm/shared';
import { newId, unitOfWork, generateSessionToken, type Db, type Tx, type Env } from '@forgepm/core';

/** argon2id parameters pinned (plan §3: Auth پنل argon2id). */
const ARGON2_OPTS = { type: argon2.argon2id, memoryCost: 64 * 1024, timeCost: 3, parallelism: 1 } as const;

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export interface SetupResult {
  organizationId: string;
  userId: string;
  sessionId: string;
  sessionToken: string;
}

/**
 * One-time bootstrap setup (plan §5.2): if no users exist, create the first
 * org + owner user + session. Once any user exists the window is closed for
 * good. Returns 409 CONFLICT if already set up.
 */
export async function oneTimeSetup(
  db: Db,
  input: { organization_name: string; admin_email: string; admin_password: string; admin_display_name: string },
): Promise<SetupResult> {
  const existing = await db.selectFrom('users').select('id').limit(1).execute();
  if (existing.length > 0) throw new AppError('CONFLICT', 'setup already completed');

  const orgId = newId();
  const userId = newId();
  const slug = slugify(input.organization_name);
  const passwordHash = await hashPassword(input.admin_password);
  const sess = newSession();

  await unitOfWork(db, async ({ tx }) => {
    await tx
      .insertInto('organizations')
      .values({ id: orgId, name: input.organization_name, slug })
      .execute();
    await tx
      .insertInto('users')
      .values({
        id: userId,
        email: input.admin_email.toLowerCase(),
        password_hash: passwordHash,
        display_name: input.admin_display_name,
      })
      .execute();
    await tx
      .insertInto('memberships')
      .values({ id: newId(), organization_id: orgId, user_id: userId, role: 'owner' })
      .execute();
    await insertSession(tx, sess, userId);
    await tx
      .insertInto('audit_events')
      .values({
        id: newId(),
        organization_id: orgId,
        actor_type: 'user',
        actor_id: userId,
        action: 'setup.complete',
        resource_type: 'organization',
        resource_id: orgId,
        summary: null,
        request_id: null,
      })
      .execute();
  });

  return { organizationId: orgId, userId, sessionId: sess.id, sessionToken: sess.token };
}

/**
 * Bootstrap admin from env (plan §5.2): used when FORGEPM_ADMIN_EMAIL/PASSWORD
 * are set on an empty DB. No-op if users already exist or env is unset.
 */
export async function bootstrapAdminFromEnv(db: Db, env: Env): Promise<boolean> {
  if (!env.FORGEPM_ADMIN_EMAIL || !env.FORGEPM_ADMIN_PASSWORD) return false;
  const existing = await db.selectFrom('users').select('id').limit(1).execute();
  if (existing.length > 0) return false;
  await oneTimeSetup(db, {
    organization_name: 'Default',
    admin_email: env.FORGEPM_ADMIN_EMAIL,
    admin_password: env.FORGEPM_ADMIN_PASSWORD,
    admin_display_name: 'Administrator',
  });
  return true;
}

export interface LoginResult {
  sessionToken: string;
  userId: string;
  organizationId: string;
}

export async function login(db: Db, email: string, password: string, meta: { ip?: string; userAgent?: string }): Promise<LoginResult> {
  const user = await db
    .selectFrom('users')
    .select(['id', 'password_hash', 'status'])
    .where('email', '=', email.toLowerCase())
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!user) throw new AppError('AUTH_INVALID_CREDENTIALS', 'invalid credentials');
  if (user.status !== 'active') throw new AppError('AUTH_INVALID_CREDENTIALS', 'invalid credentials');
  const ok = await verifyPassword(user.password_hash, password);
  if (!ok) throw new AppError('AUTH_INVALID_CREDENTIALS', 'invalid credentials');

  const membership = await db
    .selectFrom('memberships')
    .select(['organization_id', 'role'])
    .where('user_id', '=', user.id)
    .executeTakeFirst();
  if (!membership) throw new AppError('AUTH_INVALID_CREDENTIALS', 'invalid credentials');

  const sess = newSession();
  await db
    .insertInto('sessions')
    .values({
      id: sess.id,
      user_id: user.id,
      token_hash: sess.tokenHash,
      expires_at: sess.expiresAt,
      ip: meta.ip ?? null,
      user_agent: meta.userAgent ?? null,
    })
    .execute();

  return { sessionToken: sess.token, userId: user.id, organizationId: membership.organization_id };
}

export async function logout(db: Db, token: string): Promise<void> {
  const hash = sha256hex(token);
  await db.deleteFrom('sessions').where('token_hash', '=', hash).execute();
}

export interface SessionToken {
  id: string;
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

export function newSession(): SessionToken {
  const g = generateSessionToken();
  return { id: newId(), token: g.raw, tokenHash: g.hash, expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000) };
}

export function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

async function insertSession(tx: Tx, sess: SessionToken, userId: string): Promise<void> {
  await tx
    .insertInto('sessions')
    .values({ id: sess.id, user_id: userId, token_hash: sess.tokenHash, expires_at: sess.expiresAt })
    .execute();
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'org'}-${newId()}`;
}

import {
  activeCipher,
  getSecret,
  putSecret,
  recordAudit,
  newId,
  type Db,
} from '@forgepm/core';
import { AppError } from '@forgepm/shared';

/**
 * GitHub App configuration (plan §9). Stored encrypted in `secrets`:
 *  github.app_id, github.app_private_key, github.webhook_secret.
 * Env vars (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET) are
 * bootstrap-only: on first use, if the DB has no value, the env value is copied
 * into `secrets` and DB becomes the source of truth thereafter.
 */
export const GH_SECRET_KEYS = ['github.app_id', 'github.app_private_key', 'github.webhook_secret'] as const;

async function readOrBootstrap(db: Db, orgId: string, name: string, envName: string): Promise<string | null> {
  const dbVal = await getSecret(db, activeCipher(), orgId, name, 'module');
  if (dbVal) return dbVal;
  const envVal = process.env[envName];
  if (envVal) {
    await putSecret(db, activeCipher(), orgId, name, envVal, 'module');
    return envVal;
  }
  return null;
}

export async function getWebhookSecret(db: Db, orgId: string): Promise<string | null> {
  return readOrBootstrap(db, orgId, 'github.webhook_secret', 'GITHUB_WEBHOOK_SECRET');
}

export async function getAppId(db: Db, orgId: string): Promise<string | null> {
  return readOrBootstrap(db, orgId, 'github.app_id', 'GITHUB_APP_ID');
}

export async function getPrivateKey(db: Db, orgId: string): Promise<string | null> {
  return readOrBootstrap(db, orgId, 'github.app_private_key', 'GITHUB_APP_PRIVATE_KEY');
}

export interface GhConfigInput {
  app_id?: string;
  app_private_key?: string;
  webhook_secret?: string;
}

/** Store the three secrets from the panel (admin). Never echoes values back. */
export async function saveConfig(db: Db, orgId: string, actorId: string, requestId: string, cfg: GhConfigInput): Promise<{ configured: string[] }> {
  const saved: string[] = [];
  if (cfg.app_id) {
    await putSecret(db, activeCipher(), orgId, 'github.app_id', cfg.app_id, 'module');
    saved.push('github.app_id');
  }
  if (cfg.app_private_key) {
    await putSecret(db, activeCipher(), orgId, 'github.app_private_key', cfg.app_private_key, 'module');
    saved.push('github.app_private_key');
  }
  if (cfg.webhook_secret) {
    await putSecret(db, activeCipher(), orgId, 'github.webhook_secret', cfg.webhook_secret, 'module');
    saved.push('github.webhook_secret');
  }
  await db.transaction().execute(async (tx) => {
    await recordAudit(tx, {
      organization_id: orgId,
      actor_type: 'user',
      actor_id: actorId,
      action: 'github.save_config',
      resource_type: 'secret',
      resource_id: newId(),
      // never include values — only which keys were written (plan §5 acceptance).
      summary: { keys: saved },
      request_id: requestId,
    });
  });
  return { configured: saved };
}

/** Which secrets are present (last4 only). Used by the panel + validateConfig. */
export async function configStatus(db: Db, orgId: string): Promise<{ app_id_set: boolean; private_key_set: boolean; webhook_secret_set: boolean; enabled: boolean }> {
  const [appId, pk, ws] = await Promise.all([
    getSecret(db, activeCipher(), orgId, 'github.app_id', 'module'),
    getSecret(db, activeCipher(), orgId, 'github.app_private_key', 'module'),
    getSecret(db, activeCipher(), orgId, 'github.webhook_secret', 'module'),
  ]);
  return { app_id_set: !!appId || !!process.env.GITHUB_APP_ID, private_key_set: !!pk || !!process.env.GITHUB_APP_PRIVATE_KEY, webhook_secret_set: !!ws || !!process.env.GITHUB_WEBHOOK_SECRET, enabled: false };
}

/**
 * validateConfig for the module registry: enabling github requires ALL three
 * secrets to be present (DB or bootstrap env). Rejected enable keeps prior data.
 * The db passed in is used to find the first organization (single-app installs
 * have exactly one org from bootstrap).
 *
 * POU-36 acceptance:
 *  - app_id, private_key, webhook_secret must all be non-empty.
 *  - Missing any secret throws VALIDATION_ERROR with a clear message.
 */
export async function validateConfig(db: Db): Promise<void> {
  const org = await db.selectFrom('organizations').select('id').where('deleted_at', 'is', null).limit(1).executeTakeFirst();
  if (!org) throw new AppError('VALIDATION_ERROR', 'no organization yet; complete setup first');

  const appId = process.env.GITHUB_APP_ID ?? (await getSecret(db, activeCipher(), org.id, 'github.app_id', 'module'));
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY ?? (await getSecret(db, activeCipher(), org.id, 'github.app_private_key', 'module'));
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? (await getSecret(db, activeCipher(), org.id, 'github.webhook_secret', 'module'));

  const missing: string[] = [];
  if (!appId) missing.push('github.app_id');
  if (!privateKey) missing.push('github.app_private_key');
  if (!webhookSecret) missing.push('github.webhook_secret');

  if (missing.length > 0) {
    throw new AppError('VALIDATION_ERROR', `github module requires all secrets to be configured; missing: ${missing.join(', ')}`);
  }
}

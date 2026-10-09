import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AppError } from '@forgepm/shared';
import {
  getEffective,
  upsertSetting,
  deleteSetting,
  validateSettingValue,
  isKnownSettingKey,
  settingDefault,
  SETTING_DEFINITIONS,
  unitOfWork,
  recordAudit,
  authorize,
  type SettingsScope,
  type Db,
} from '@forgepm/core';
import type { AppDeps } from '../../app/app';
import { guard, requireActor } from '../../app/guards';
import { assertProjectAccess } from '../projects/access';
import type { Actor } from '../../app/auth-context';

const scopePath = z.object({ scope: z.enum(['system', 'organization', 'project']), scope_id: z.string(), key: z.string().min(1).max(128) });

/**
 * Settings routes (plan §5.7): effective value + source, and per-scope
 * override/inheritance. `organization` scope_id is `me` (actor's org);
 * `system` scope_id is `-`. Registry validation + audit on every mutation.
 */
export function registerSettingsRoutes(app: FastifyInstance, deps: AppDeps): void {
  const t = app.withTypeProvider<ZodTypeProvider>();
  const db = deps.db;

  function resolveScopeId(actor: { organizationId: string }, scope: SettingsScope, raw: string): string | null {
    if (scope === 'system') return null;
    if (scope === 'organization') return raw === 'me' ? actor.organizationId : raw;
    return raw; // project id
  }

  // The registry listing (for the panel to render forms + inheritance badges).
  t.get(
    '/api/v1/settings/registry',
    { preHandler: guard(db, { action: 'project:read' }) },
    async () => ({
      settings: [
        ...SETTING_DEFINITIONS.map((d) => ({ key: d.key, category: d.category, default: d.default })),
      ],
    }),
  );

  // Effective value + source for a single key at a given scope target.
  t.get(
    '/api/v1/settings/effective',
    {
      schema: {
        querystring: z.object({ key: z.string(), scope: z.enum(['system', 'organization', 'project']).default('system'), scope_id: z.string().optional() }),
        response: { 200: z.object({ key: z.string(), value: z.unknown(), source: z.enum(['system', 'organization', 'project', 'default']) }) },
      },
      preHandler: guard(db, { action: 'project:read' }),
    },
    async (req) => {
      const actor = requireActor(req);
      const scopeId = resolveScopeId(actor, req.query.scope, req.query.scope_id ?? '');
      const orgId = req.query.scope === 'project' ? actor.organizationId : scopeId;
      const projectId = req.query.scope === 'project' ? scopeId : null;
      const eff = await getEffective(db, req.query.key, orgId, projectId);
      if (eff) return { key: req.query.key, value: eff.value, source: eff.source };
      return { key: req.query.key, value: settingDefault(req.query.key) ?? null, source: 'default' as const };
    },
  );

  t.put(
    '/api/v1/settings/:scope/:scope_id/:key',
    { schema: { params: scopePath, body: z.object({ value: z.unknown() }) }, preHandler: guard(db, {}) },
    async (req) => {
      const actor = requireActor(req);
      const { scope, key } = req.params;
      await authorizeSettingWrite(actor, scope, req.params.scope_id, db);
      if (!isKnownSettingKey(key)) throw new AppError('VALIDATION_ERROR', `unknown setting key '${key}'`);
      const v = validateSettingValue(key, req.body.value);
      if (!v.ok) throw new AppError('VALIDATION_ERROR', v.message);
      const scopeId = resolveScopeId(actor, scope, req.params.scope_id);
      await unitOfWork(db, async ({ tx }) => {
        await upsertSetting(tx, scope, scopeId, key, v.value);
        await recordAudit(tx, {
          organization_id: actor.organizationId,
          actor_type: 'user',
          actor_id: actor.id,
          action: 'setting.set',
          resource_type: 'setting',
          resource_id: '00000000-0000-7000-8000-000000000001',
          summary: { scope, scope_id: scopeId, key, value: v.value },
          request_id: actor.requestId,
        });
      });
      return { key, scope, source: scope, value: v.value };
    },
  );

  t.delete(
    '/api/v1/settings/:scope/:scope_id/:key',
    { schema: { params: scopePath }, preHandler: guard(db, {}) },
    async (req) => {
      const actor = requireActor(req);
      await authorizeSettingWrite(actor, req.params.scope, req.params.scope_id, db);
      const scopeId = resolveScopeId(actor, req.params.scope, req.params.scope_id);
      await unitOfWork(db, async ({ tx }) => {
        await deleteSetting(tx, req.params.scope, scopeId, req.params.key);
        await recordAudit(tx, {
          organization_id: actor.organizationId,
          actor_type: 'user',
          actor_id: actor.id,
          action: 'setting.delete',
          resource_type: 'setting',
          resource_id: '00000000-0000-7000-8000-000000000001',
          summary: { scope: req.params.scope, scope_id: scopeId, key: req.params.key },
          request_id: actor.requestId,
        });
      });
      return { status: 'ok' };
    },
  );
}

/**
 * Scope-dependent authorization for setting writes (plan §5.7 + matrix):
 *   system       -> settings:system (owner)
 *   organization -> settings:system (owner; org-wide default is sensitive)
 *   project      -> project:settings (admin/owner or project lead)
 */
async function authorizeSettingWrite(actor: Actor, scope: SettingsScope, scopeId: string, db: Db): Promise<void> {
  if (scope === 'system' || scope === 'organization') {
    authorize({ orgRole: actor.orgRole, projectRole: null }, 'settings:system');
    return;
  }
  await assertProjectAccess(db, actor, scopeId, 'project:settings');
}

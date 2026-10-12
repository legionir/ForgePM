import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { createApiKeySchema, apiKeyDtoSchema, AppError, type ApiKeyDto } from '@forgepm/shared';
import { newId, generateApiKey, unitOfWork, recordAudit } from '@forgepm/core';
import type { AppDeps } from '../../app/app';
import { guard, requireActor } from '../../app/guards';

const KEY_COLUMNS = [
  'id',
  'name',
  'prefix',
  'scopes',
  'project_ids',
  'owner_user_id',
  'agent_id',
  'expires_at',
  'revoked_at',
  'created_at',
] as const;

function toDto(r: Record<string, unknown>): ApiKeyDto {
  return {
    id: r.id as string,
    name: r.name as string,
    prefix: r.prefix as string,
    scopes: (r.scopes as string[]) ?? [],
    project_ids: (r.project_ids as string[]) ?? [],
    owner_user_id: (r.owner_user_id as string | null) ?? null,
    agent_id: (r.agent_id as string | null) ?? null,
    expires_at: r.expires_at ? (r.expires_at as Date).toISOString() : null,
    revoked_at: r.revoked_at ? (r.revoked_at as Date).toISOString() : null,
    created_at: (r.created_at as Date).toISOString(),
  };
}

export function registerApiKeysRoutes(app: FastifyInstance, deps: AppDeps): void {
  const t = app.withTypeProvider<ZodTypeProvider>();
  const db = deps.db;

  t.get(
    '/api/v1/api-keys',
    {
      schema: { response: { 200: z.object({ items: z.array(apiKeyDtoSchema) }) } },
      preHandler: guard(db, { action: 'apikeys:self' }),
    },
    async (req) => {
      const actor = requireActor(req);
      const isAdmin = actor.orgRole === 'owner' || actor.orgRole === 'admin';
      let q = db.selectFrom('api_keys').select(KEY_COLUMNS).where('organization_id', '=', actor.organizationId);
      if (!isAdmin) q = q.where('owner_user_id', '=', actor.id);
      const rows = await q.orderBy('created_at', 'desc').execute();
      return { items: rows.map((r) => toDto(r as unknown as Record<string, unknown>)) };
    },
  );

  t.post(
    '/api/v1/api-keys',
    {
      schema: {
        body: createApiKeySchema,
        // raw appears ONCE here; never stored in the clear (plan §5.4, §5 acceptance).
        response: { 201: z.object({ api_key: apiKeyDtoSchema, raw_key: z.string() }) },
      },
      preHandler: guard(db, { action: 'apikeys:self' }),
    },
    async (req, reply) => {
      const actor = requireActor(req);
      const gen = generateApiKey();
      const id = newId();
      const ownerId = req.body.agent_id ? null : actor.id;

      // POU-12 escalation guard: a key can never mint more power than it holds.
      // Agents may not mint keys at all; a key-authenticated caller may only
      // mint scopes it already has (an `admin` key may mint any scope).
      if (actor.type === 'agent') throw new AppError('FORBIDDEN', 'agents may not mint api keys');
      if (actor.apiKeyId) {
        const held = new Set<string>(actor.scopes);
        if (!held.has('admin') && req.body.scopes.some((s) => !held.has(s))) {
          throw new AppError('FORBIDDEN', 'key scopes must be a subset of the calling key scopes');
        }
      }
      // Human session owners must have an admin role to mint agent keys or
      // anything beyond read-only keys; expiry is capped at one year.
      const isAdmin = actor.orgRole === 'owner' || actor.orgRole === 'admin';
      if (req.body.agent_id) {
        if (!isAdmin) throw new AppError('FORBIDDEN', 'only admins may mint agent keys');
      } else if (!isAdmin) {
        if (req.body.scopes.some((s) => s !== 'read')) {
          throw new AppError('FORBIDDEN', 'non-admin may only create read-scoped keys');
        }
        if (req.body.expires_at) {
          const expiresAt = new Date(req.body.expires_at);
          if (expiresAt.getTime() > Date.now() + 365 * 24 * 60 * 60 * 1000) {
            throw new AppError('FORBIDDEN', 'expiry may not exceed 1 year from now');
          }
        }
      }

      await unitOfWork(db, async ({ tx }) => {
        await tx
          .insertInto('api_keys')
          .values({
            id,
            organization_id: actor.organizationId,
            owner_user_id: ownerId,
            agent_id: req.body.agent_id ?? null,
            key_hash: gen.key_hash,
            prefix: gen.prefix,
            name: req.body.name,
            scopes: req.body.scopes as never,
            project_ids: (req.body.project_ids ?? []) as never,
            expires_at: req.body.expires_at ? new Date(req.body.expires_at) : null,
          })
          .execute();
        await recordAudit(tx, {
          organization_id: actor.organizationId,
          actor_type: 'user',
          actor_id: actor.id,
          action: 'api_key.create',
          resource_type: 'api_key',
          resource_id: id,
          // store only the prefix — never the raw key or hash (plan §5 acceptance).
          summary: { name: req.body.name, prefix: gen.prefix, scopes: req.body.scopes },
          request_id: actor.requestId,
        });
      });
      const row = await db.selectFrom('api_keys').select(KEY_COLUMNS).where('id', '=', id).executeTakeFirstOrThrow();
      return reply.status(201).send({ api_key: toDto(row as unknown as Record<string, unknown>), raw_key: gen.raw });
    },
  );

  t.delete(
    '/api/v1/api-keys/:id',
    { schema: { params: z.object({ id: z.string().uuid() }) }, preHandler: guard(db, { action: 'apikeys:self' }) },
    async (req, reply) => {
      const actor = requireActor(req);
      const existing = await db
        .selectFrom('api_keys')
        .select(['id', 'owner_user_id'])
        .where('id', '=', req.params.id)
        .where('organization_id', '=', actor.organizationId)
        .executeTakeFirst();
      if (!existing) throw new AppError('NOT_FOUND', 'api key not found');
      const isAdmin = actor.orgRole === 'owner' || actor.orgRole === 'admin';
      if (!isAdmin && existing.owner_user_id !== actor.id) throw new AppError('FORBIDDEN', 'not your api key');
      await unitOfWork(db, async ({ tx }) => {
        await tx.updateTable('api_keys').set({ revoked_at: new Date(), updated_at: new Date() }).where('id', '=', req.params.id).execute();
        await recordAudit(tx, {
          organization_id: actor.organizationId,
          actor_type: 'user',
          actor_id: actor.id,
          action: 'api_key.revoke',
          resource_type: 'api_key',
          resource_id: req.params.id,
          summary: null,
          request_id: actor.requestId,
        });
      });
      return reply.status(204).send();
    },
  );
}

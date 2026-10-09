import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AppError } from '@forgepm/shared';
import { guard, requireActor } from '../../app/guards';
import { authorize, tokensUsedToday } from '@forgepm/core';
import type { AppDeps } from '../../app/app';
import {
  createProvider,
  decryptKey,
  listProviders,
  getProvider,
  type ProviderRow,
} from './service';
import { isBlockedPrivateHost } from '../../app/ssrf';

const providerDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['anthropic', 'openai', 'openai_compatible', 'fake']),
  base_url: z.string().nullable(),
  key_last4: z.string().nullable(),
  default_model: z.string().nullable(),
  enabled: z.boolean(),
});

function toDto(r: ProviderRow) {
  return { id: r.id, name: r.name, kind: r.kind, base_url: r.base_url, key_last4: r.key_last4, default_model: r.default_model, enabled: r.enabled };
}

export function registerAiProvidersRoutes(app: FastifyInstance, deps: AppDeps): void {
  const t = app.withTypeProvider<ZodTypeProvider>();
  const db = deps.db;

  t.get(
    '/api/v1/ai-providers',
    { schema: { response: { 200: z.object({ items: z.array(providerDtoSchema), used_tokens_today: z.number() }) } }, preHandler: guard(db, { action: 'settings:system' }) },
    async (req) => {
      const actor = requireActor(req);
      const items = await listProviders(db, actor.organizationId);
      return { items: items.map(toDto), used_tokens_today: await tokensUsedToday(db, actor.organizationId) };
    },
  );

  t.post(
    '/api/v1/ai-providers',
    {
      schema: {
        body: z.object({
          name: z.string().min(1).max(120),
          kind: z.enum(['anthropic', 'openai', 'openai_compatible', 'fake']),
          base_url: z.string().url().max(2000).optional(),
          api_key: z.string().max(512).optional(),
          default_model: z.string().max(120).optional(),
          enabled: z.boolean().optional(),
        }),
        response: { 201: providerDtoSchema },
      },
      preHandler: guard(db, {}),
    },
    async (req, reply) => {
      const actor = requireActor(req);
      authorize({ orgRole: actor.orgRole, projectRole: null }, 'settings:system');
      if (req.body.base_url && (await isBlockedPrivateHost(req.body.base_url))) {
        throw new AppError('SSRF_BLOCKED', 'private or link-local base_url requires the network.allow_private_targets setting');
      }
      const id = await createProvider(db, actor.organizationId, actor.id, actor.requestId, req.body);
      const p = await getProvider(db, id, actor.organizationId);
      return reply.status(201).send(toDto(p!));
    },
  );

  // connection test: for `fake` always passes; real kinds ping the endpoint.
  t.post(
    '/api/v1/ai-providers/:id/test',
    { schema: { params: z.object({ id: z.string().uuid() }), response: { 200: z.object({ ok: z.boolean() }) } }, preHandler: guard(db, {}) },
    async (req) => {
      const actor = requireActor(req);
      authorize({ orgRole: actor.orgRole, projectRole: null }, 'settings:system');
      const p = await getProvider(db, req.params.id, actor.organizationId);
      if (!p) throw new AppError('NOT_FOUND', 'provider not found');
      if (p.kind === 'fake') return { ok: true };
      // real provider: ensure a key is decryptable (network call out of scope).
      const key = await decryptKey(db, p.id, actor.organizationId);
      return { ok: !!key };
    },
  );
}

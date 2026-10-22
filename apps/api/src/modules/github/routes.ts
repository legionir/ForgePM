import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AppError } from '@forgepm/shared';
import {
  activeCipher,
  findSecretByName,
  putSecret,
  makeRequireModule,
  newId,
  toJsonb,
  importIssueEvent,
  recordRelease,
  SYSTEM_ACTOR_ID,
  type Db,
  type ModuleRegistry,
} from '@forgepm/core';
import { guard, requireActor } from '../../app/guards';
import { verifyWebhookSignature } from './parse';
import { saveConfig, configStatus, type GhConfigInput } from './config';
import {
  connectRepoToProject,
  disconnectRepoFromProject,
  developmentFor,
  listProjectRepositories,
  listRepositories,
  upsertRepository,
  processPullRequest,
} from './service';
import { assertProjectAccess } from '../projects/access';
import { getWorkItemByKey } from '../work-items/items-repository';

export interface RawBodyRequest extends FastifyRequest {
  rawBody?: string;
}

/**
 * GitHub module routes (plan §9). Every entry point is guarded by
 * `requireModule('github', …)` so a disabled module returns 503 MODULE_DISABLED.
 * The core runs fully with zero github config (webhook returns 503).
 */
export function registerGithubRoutes(app: FastifyInstance, deps: { db: Db; registry: ModuleRegistry }): void {
  const db = deps.db;
  const requireModule = makeRequireModule(deps.registry, db);
  const GH_CTX = { organizationId: null, projectId: null };
  const t = app.withTypeProvider<ZodTypeProvider>();

  // The JSON content-type parser that captures `rawBody` (for HMAC verification)
  // is installed once in app.ts buildApp; this module reuses it.

  // ---- webhook receiver (machine path, not session-authed) ----
  app.post('/integrations/github/webhook', async (req, reply) => {
    await requireModule('github', GH_CTX);
    const r = req as RawBodyRequest;
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const event = (req.headers['x-github-event'] as string | undefined) ?? 'unknown';
    const deliveryId = (req.headers['x-github-delivery'] as string | undefined) ?? newId();

    const secretRec = await findSecretByName(db, activeCipher(), 'github.webhook_secret');
    let secret = secretRec?.value ?? process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) throw new AppError('MODULE_DISABLED', 'github webhook secret not configured');
    if (!verifyWebhookSignature(secret, r.rawBody ?? '', signature)) {
      throw new AppError('AUTH_REQUIRED', 'invalid webhook signature');
    }
    // Resolve the owning org: from the stored secret, else the first org
    // (single-app installs). Bootstrap the env secret into `secrets` for that
    // org so DB becomes the source of truth thereafter (plan §3b-1.5).
    let orgId = secretRec?.organization_id ?? '';
    if (!orgId) {
      const org = await db.selectFrom('organizations').select('id').where('deleted_at', 'is', null).limit(1).executeTakeFirst();
      if (!org) throw new AppError('MODULE_DISABLED', 'github: no organization configured');
      orgId = org.id;
      if (process.env.GITHUB_WEBHOOK_SECRET) {
        await putSecret(db, activeCipher(), orgId, 'github.webhook_secret', process.env.GITHUB_WEBHOOK_SECRET, 'module');
      }
    }
    // Store delivery + enqueue processing in ONE tx. UNIQUE(delivery_id) makes
    // a duplicate delivery a no-op (still 202, still exactly one processing).
    await db.transaction().execute(async (tx) => {
      const inserted = await tx
        .insertInto('webhook_deliveries')
        .values({ id: newId(), organization_id: orgId, delivery_id: deliveryId, event, payload: toJsonb(r.body ?? {}) as never, status: 'received' })
        .onConflict((oc) => oc.column('delivery_id').doNothing())
        .returning('id')
        .executeTakeFirst();
      if (inserted) {
        await tx
          .insertInto('outbox')
          .values({ id: newId(), organization_id: orgId, topic: 'github.process_delivery', payload: toJsonb({ delivery_id: deliveryId }) as never })
          .execute();
      }
    });
    return reply.status(202).send({ status: 'accepted' });
  });

  // ---- admin: config + status ----
  t.post(
    '/api/v1/integrations/github/config',
    {
      schema: {
        body: z.object({ app_id: z.string().max(64).optional(), app_private_key: z.string().max(8192).optional(), webhook_secret: z.string().max(256).optional() }),
        response: { 200: z.object({ configured: z.array(z.string()) }) },
      },
      preHandler: guard(db, { action: 'secrets:manage' }),
    },
    async (req) => {
      const actor = requireActor(req);
      return saveConfig(db, actor.organizationId, actor.id, actor.requestId, req.body as GhConfigInput);
    },
  );

  t.get('/api/v1/integrations/github/status', { preHandler: guard(db, { action: 'secrets:manage' }) }, async (req) => {
    const actor = requireActor(req);
    const status = await configStatus(db, actor.organizationId);
    const enabled = await deps.registry.isEnabled(db, 'github', actor.organizationId, null);
    return { ...status, enabled };
  });

  // ---- repositories ----
  t.get('/api/v1/repositories', { preHandler: guard(db, { action: 'project:read' }) }, async (req) => {
    const actor = requireActor(req);
    return { items: await listRepositories(db, actor.organizationId) };
  });

  t.post(
    '/api/v1/projects/:id/repositories',
    { schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ repository_id: z.string().uuid() }) }, preHandler: guard(db, {}) },
    async (req, reply) => {
      const actor = requireActor(req);
      await requireModule('github', { organizationId: actor.organizationId, projectId: req.params.id });
      await connectRepoToProject(db, actor, req.params.id, req.body.repository_id);
      return reply.status(201).send({ status: 'ok' });
    },
  );

  t.get(
    '/api/v1/projects/:id/repositories',
    { schema: { params: z.object({ id: z.string().uuid() }) }, preHandler: guard(db, {}) },
    async (req) => {
      const actor = requireActor(req);
      await requireModule('github', { organizationId: actor.organizationId, projectId: req.params.id });
      return { items: await listProjectRepositories(db, actor, req.params.id) };
    },
  );

  t.delete(
    '/api/v1/projects/:id/repositories/:repositoryId',
    { schema: { params: z.object({ id: z.string().uuid(), repositoryId: z.string().uuid() }) }, preHandler: guard(db, {}) },
    async (req) => {
      const actor = requireActor(req);
      await requireModule('github', { organizationId: actor.organizationId, projectId: req.params.id });
      const removed = await disconnectRepoFromProject(db, actor, req.params.id, req.params.repositoryId);
      return { status: 'ok', removed };
    },
  );

  // Manual PR link from the panel (github_link_pull_request also exists on MCP).
  t.post(
    '/api/v1/projects/:id/pull-requests',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          repository_external_id: z.string().max(120),
          repository_full_name: z.string().max(200),
          pr_external_id: z.string().max(120),
          number: z.number().int(),
          title: z.string().max(500),
          state: z.string().max(32),
          draft: z.boolean().default(false),
          author: z.string().max(200).nullable().optional(),
          head_sha: z.string().max(80).nullable().optional(),
          body: z.string().max(20_000).nullable().optional(),
          head_ref: z.string().max(200).nullable().optional(),
          action: z.enum(['opened', 'synchronize', 'closed', 'ready_for_review']).default('opened'),
          merged: z.boolean().default(false),
          merged_at: z.string().datetime().nullable().optional(),
        }),
      },
      preHandler: guard(db, {}),
    },
    async (req, reply) => {
      const actor = requireActor(req);
      await requireModule('github', { organizationId: actor.organizationId, projectId: req.params.id });
      await assertProjectAccess(db, actor, req.params.id, 'project:write');
      const repoId = await upsertRepository(db, actor.organizationId, { external_id: req.body.repository_external_id, full_name: req.body.repository_full_name });
      await connectRepoToProject(db, actor, req.params.id, repoId);
      const out = await processPullRequest(db, actor.organizationId, {
        action: req.body.action,
        repository_external_id: req.body.repository_external_id,
        repository_full_name: req.body.repository_full_name,
        pr_external_id: req.body.pr_external_id,
        number: req.body.number,
        title: req.body.title,
        state: req.body.state,
        draft: req.body.draft,
        author: req.body.author ?? null,
        head_sha: req.body.head_sha ?? null,
        body: req.body.body ?? null,
        head_ref: req.body.head_ref ?? null,
        merged: req.body.merged,
        merged_at: req.body.merged_at ?? null,
      });
      return reply.status(201).send(out);
    },
  );

  // ---- Development tab (work item) ----
  t.get(
    '/api/v1/work-items/:key/development',
    { schema: { params: z.object({ key: z.string() }) }, preHandler: guard(db, {}) },
    async (req) => {
      const actor = requireActor(req);
      const item = await getWorkItemByKey(db, actor.organizationId, req.params.key);
      if (!item) throw new AppError('NOT_FOUND', 'work item not found');
      await assertProjectAccess(db, actor, item.project_id as string, 'project:read');
      return { items: await developmentFor(db, actor.organizationId, item.id as string) };
    },
  );

  // ---- Manual issue import (one-way; worker uses the same core function) ----
  t.post(
    '/api/v1/projects/:id/issues/import',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          repository_external_id: z.string().max(120),
          repository_full_name: z.string().max(200),
          issue_number: z.number().int().min(1),
          title: z.string().max(500),
          body: z.string().max(20_000).nullable().optional(),
          state: z.string().max(32),
          labels: z.array(z.string().max(60)).default([]),
          remote_version: z.string().max(120).nullable().optional(),
        }),
        response: { 200: z.object({ action: z.string(), repository_id: z.string() }), 201: z.object({ action: z.string(), repository_id: z.string() }) },
      },
      preHandler: guard(db, {}),
    },
    async (req, reply) => {
      const actor = requireActor(req);
      await requireModule('github', { organizationId: actor.organizationId, projectId: req.params.id });
      await assertProjectAccess(db, actor, req.params.id, 'project:write');
      const repoId = await upsertRepository(db, actor.organizationId, { external_id: req.body.repository_external_id, full_name: req.body.repository_full_name });
      const action = await importIssueEvent(
        db,
        actor.organizationId,
        req.params.id,
        {
          repository_external_id: req.body.repository_external_id,
          repository_full_name: req.body.repository_full_name,
          issue_number: req.body.issue_number,
          title: req.body.title,
          body: req.body.body ?? null,
          state: req.body.state,
          labels: req.body.labels,
          remote_version: req.body.remote_version ?? null,
        },
        SYSTEM_ACTOR_ID,
      );
      return reply.status(action === 'created' ? 201 : 200).send({ action, repository_id: repoId });
    },
  );

  // ---- Manual release record (plan §9.6) ----
  t.post(
    '/api/v1/projects/:id/releases',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          repository_external_id: z.string().max(120),
          repository_full_name: z.string().max(200),
          tag: z.string().max(120),
          published_at: z.string().datetime().nullable().optional(),
          notes: z.string().max(4000).nullable().optional(),
        }),
        response: { 201: z.object({ created: z.boolean(), repository_id: z.string() }) },
      },
      preHandler: guard(db, {}),
    },
    async (req, reply) => {
      const actor = requireActor(req);
      await requireModule('github', { organizationId: actor.organizationId, projectId: req.params.id });
      await assertProjectAccess(db, actor, req.params.id, 'project:write');
      const out = await recordRelease(db, actor.organizationId, { external_id: req.body.repository_external_id, full_name: req.body.repository_full_name }, req.body.tag, req.body.published_at ?? null, req.body.notes ?? null);
      return reply.status(201).send({ created: out.created, repository_id: out.repoId });
    },
  );
}

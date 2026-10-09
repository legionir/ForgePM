import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { AppError, ERROR_CODES } from '@forgepm/shared';
import { ModuleRegistry, makeRequireModule, loggerOptions, pingDb, type Env } from '@forgepm/core';
import { randomUUID } from 'node:crypto';
import type { Db } from '@forgepm/core';
import { registerSampleModule } from '../modules/sample/routes';
import { registerModulesRoutes } from '../modules/settings/routes';
import { collectRoutes, buildOpenApiDocument } from './openapi';

export interface AppDeps {
  env: Env;
  db: Db;
  registry: ModuleRegistry;
  /** Redis reachability probe for /health/ready (worker/queue health). */
  redisAvailable(): Promise<boolean>;
}

export type RequireModuleFn = (
  name: string,
  ctx: { organizationId: string | null; projectId: string | null },
) => Promise<void>;

declare module 'fastify' {
  interface FastifyInstance {
    requireModule: RequireModuleFn;
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(deps.env.LOG_LEVEL, { component: 'api' }) as FastifyServerOptions['logger'],
    genReqId: () => randomUUID(),
    bodyLimit: 1 * 1024 * 1024, // 1 MiB (plan §14); webhook route raises its own limit
    trustProxy: true,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, { origin: [deps.env.WEB_ORIGIN], credentials: true });

  // Security headers (helmet-equivalent minimal set, plan §14).
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    return payload;
  });

  // Route collector must be installed BEFORE routes are registered.
  const routeSink = collectRoutes(app);

  registerErrorHandlers(app);
  registerHealth(app, deps);
  registerSampleModule(app);
  registerModulesRoutes(app, deps);
  app.get('/api/v1/openapi.json', async (_req, reply) => reply.send(buildOpenApiDocument(routeSink())));

  app.decorate('requireModule', makeRequireModule(deps.registry, deps.db));

  return app;
}

function registerErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((err: Error & { code?: string; validation?: unknown }, req, reply) => {
    const requestId = req.id;
    if (err instanceof AppError) {
      return reply.status(err.httpStatus).send(err.toJSON(requestId));
    }
    if (err.code === 'FST_ERR_VALIDATION') {
      const e = new AppError('VALIDATION_ERROR', err.message, err.validation);
      return reply.status(400).send(e.toJSON(requestId));
    }
    req.log.error({ err, request_id: requestId }, 'unhandled error');
    const e = new AppError('INTERNAL', 'internal error');
    return reply.status(ERROR_CODES.INTERNAL).send(e.toJSON(requestId));
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `route ${req.method} ${req.url} not found`, request_id: req.id },
    });
  });
}

async function registerHealth(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/health/live', async () => ({ status: 'ok' }));

  // readiness: Postgres AND Redis must both be reachable, else 503 (acceptance §4).
  app.get('/health/ready', async (_req, reply) => {
    const checks: Record<string, string> = {};
    let ok = true;
    try {
      await pingDb(deps.db);
      checks.postgres = 'ok';
    } catch {
      checks.postgres = 'down';
      ok = false;
    }
    try {
      const redisOk = await deps.redisAvailable();
      checks.redis = redisOk ? 'ok' : 'down';
      if (!redisOk) ok = false;
    } catch {
      checks.redis = 'down';
      ok = false;
    }
    if (!ok) return reply.status(503).send({ status: 'degraded', ...checks });
    return reply.status(200).send({ status: 'ok', ...checks });
  });
}

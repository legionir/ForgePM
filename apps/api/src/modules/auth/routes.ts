import type { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { loginSchema, setupSchema, AppError } from '@forgepm/shared';
import { generateCsrfToken } from '@forgepm/core';
import type { AppDeps } from '../../app/app';
import { oneTimeSetup, login, logout } from './service';
import { authenticate, SESSION_COOKIE, SESSION_TTL_MS } from '../../app/auth-context';

const CSRF_COOKIE = 'fpm_csrf';
const CSRF_HEADER = 'x-csrf-token';

/**
 * Auth routes (plan §5.3). Login sets an httpOnly SameSite=Lax session cookie
 * plus a readable CSRF cookie; mutating requests must echo the CSRF header.
 * Rate limit for /auth/login: 10 attempts / 15 min per IP+email.
 */
export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const t = app.withTypeProvider<ZodTypeProvider>();

  // A stable per-process store so we can hit the rate limiter without a real
  // Redis instance in the API (rate-limit uses an LRU in-memory store here).
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();
  function tooMany(key: string): boolean {
    const now = Date.now();
    const hit = loginAttempts.get(key);
    if (!hit || hit.resetAt <= now) {
      loginAttempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
      return false;
    }
    hit.count += 1;
    return hit.count > 10;
  }

  t.post(
    '/api/v1/auth/login',
    {
      schema: { body: loginSchema },
      config: { rateLimit: { max: 100, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const { email, password } = req.body;
      const rlKey = `${req.ip}|${email.toLowerCase()}`;
      if (tooMany(rlKey)) throw new AppError('RATE_LIMITED', 'too many login attempts');
      const res = await login(deps.db, email, password, { ip: req.ip, userAgent: req.headers['user-agent'] });
      loginAttempts.delete(rlKey); // success clears the failure counter
      setSessionCookies(reply, res.sessionToken);
      return { status: 'ok' };
    },
  );

  t.post('/api/v1/auth/logout', async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await logout(deps.db, token);
    clearSessionCookies(reply);
    return { status: 'ok' };
  });

  t.get('/api/v1/auth/me', async (req) => {
    const actor = await authenticate(deps.db, req);
    const user =
      actor.type === 'user'
        ? await deps.db
            .selectFrom('users')
            .select(['id', 'email', 'display_name', 'locale', 'timezone'])
            .where('id', '=', actor.id)
            .executeTakeFirst()
        : null;
    return {
      actor: { type: actor.type, id: actor.id, organization_id: actor.organizationId, org_role: actor.orgRole },
      user: user ?? null,
      csrf_token: req.cookies?.[CSRF_COOKIE] ?? null,
    };
  });

  t.post(
    '/api/v1/auth/setup',
    { schema: { body: setupSchema } },
    async (req, reply) => {
      const res = await oneTimeSetup(deps.db, req.body);
      setSessionCookies(reply, res.sessionToken);
      return { status: 'ok', organization_id: res.organizationId, user_id: res.userId };
    },
  );

  // CSRF bootstrap for a fresh browser that hasn't logged in yet.
  app.get('/api/v1/auth/csrf', async (_req, reply) => {
    const token = generateCsrfToken();
    reply.setCookie(CSRF_COOKIE, token, { path: '/', sameSite: 'lax', secure: false });
    return { csrf_token: token };
  });
}

function setSessionCookies(reply: import('fastify').FastifyReply, sessionToken: string): void {
  reply.setCookie(SESSION_COOKIE, sessionToken, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  const csrf = generateCsrfToken();
  reply.setCookie(CSRF_COOKIE, csrf, {
    path: '/',
    httpOnly: false,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });
}

function clearSessionCookies(reply: import('fastify').FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  reply.clearCookie(CSRF_COOKIE, { path: '/' });
}

/** CSRF guard used by protected mutating routes (plan §5.3). */
export async function csrfGuard(req: import('fastify').FastifyRequest): Promise<void> {
  if (req.headers.authorization?.startsWith('Bearer ')) return; // API keys are not cookie-authed
  const cookie = req.cookies?.[CSRF_COOKIE];
  const header = req.headers[CSRF_HEADER];
  if (!cookie || typeof header !== 'string' || header !== cookie) {
    throw new AppError('FORBIDDEN', 'csrf token mismatch');
  }
}

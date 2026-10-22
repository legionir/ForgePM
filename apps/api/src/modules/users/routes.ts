import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  createUserSchema,
  updateUserSchema,
  userDtoSchema,
  membershipSchema,
  listQuerySchema,
  paginatedResponseSchema,
  AppError,
  decodeCursor,
  encodeCursor,
  type UserDto,
} from '@forgepm/shared';
import { newId, unitOfWork, recordAudit } from '@forgepm/core';
import type { AppDeps } from '../../app/app';
import { guard, requireActor } from '../../app/guards';
import { cursorTs, rowCursorTs, tsParam } from '../../app/keyset';
import { hashPassword } from '../auth/service';

const USER_COLUMNS = ['id', 'email', 'display_name', 'locale', 'timezone', 'status', 'created_at'] as const;

function toUserDto(r: Record<string, unknown>): UserDto {
  return {
    id: r.id as string,
    email: r.email as string,
    display_name: r.display_name as string,
    locale: r.locale as 'en' | 'fa',
    timezone: r.timezone as string,
    status: r.status as 'active' | 'disabled',
    created_at: (r.created_at as Date).toISOString(),
  };
}

export function registerUsersRoutes(app: FastifyInstance, deps: AppDeps): void {
  const t = app.withTypeProvider<ZodTypeProvider>();
  const db = deps.db;
  const userResponse = { 200: userDtoSchema, 201: userDtoSchema };

  t.get(
    '/api/v1/users',
    {
      schema: { querystring: listQuerySchema, response: { 200: paginatedResponseSchema(userDtoSchema) } },
      preHandler: guard(db, { action: 'users:manage' }),
    },
    async (req) => {
      const actor = requireActor(req);
      const QC = USER_COLUMNS.map((c) => `users.${c}`) as never;
      let q = db
        .selectFrom('users')
        .select(QC)
        .select(cursorTs('users.created_at'))
        .where('users.deleted_at', 'is', null)
        .innerJoin('memberships', 'memberships.user_id', 'users.id')
        .where('memberships.organization_id', '=', actor.organizationId);
      if (req.query.cursor) {
        const { createdAt, id } = decodeCursor(req.query.cursor);
        q = q.where((eb) =>
          eb.or([eb('users.created_at', '<', tsParam(createdAt)), eb.and([eb('users.created_at', '=', tsParam(createdAt)), eb('users.id', '<', id)])]),
        );
      }
      const rows = (await q.orderBy('users.created_at', 'desc').orderBy('users.id', 'desc').limit(req.query.limit + 1).execute()) as unknown as Record<string, unknown>[];
      const hasMore = rows.length > req.query.limit;
      const slice = hasMore ? rows.slice(0, req.query.limit) : rows;
      return {
        items: slice.map(toUserDto),
        next_cursor: hasMore ? encodeCursor(rowCursorTs(slice[slice.length - 1]), slice[slice.length - 1].id as string) : null,
      };
    },
  );

  t.post(
    '/api/v1/users',
    { schema: { body: createUserSchema, response: userResponse }, preHandler: guard(db, { action: 'users:manage' }) },
    async (req, reply) => {
      const actor = requireActor(req);
      const id = newId();
      const passwordHash = await hashPassword(req.body.password);
      await unitOfWork(db, async ({ tx }) => {
        try {
          await tx
            .insertInto('users')
            .values({
              id,
              email: req.body.email.toLowerCase(),
              password_hash: passwordHash,
              display_name: req.body.display_name,
              locale: req.body.locale,
              timezone: req.body.timezone,
            })
            .execute();
        } catch (err) {
          if ((err as { code?: string }).code === '23505') throw new AppError('CONFLICT', 'email already exists');
          throw err;
        }
        await tx
          .insertInto('memberships')
          .values({ id: newId(), organization_id: actor.organizationId, user_id: id, role: 'member' })
          .execute();
        await recordAudit(tx, {
          organization_id: actor.organizationId,
          actor_type: 'user',
          actor_id: actor.id,
          action: 'user.create',
          resource_type: 'user',
          resource_id: id,
          summary: { email: req.body.email },
          request_id: actor.requestId,
        });
      });
      const u = await db.selectFrom('users').select(USER_COLUMNS).where('id', '=', id).executeTakeFirstOrThrow();
      return reply.status(201).send(toUserDto(u as unknown as Record<string, unknown>));
    },
  );

  t.patch(
    '/api/v1/users/:id',
    {
      schema: { params: z.object({ id: z.string().uuid() }), body: updateUserSchema, response: userResponse },
      preHandler: guard(db, { action: 'users:manage' }),
    },
    async (req) => {
      const actor = requireActor(req);
      // POU-13: verify target belongs to actor's org before any mutation
      const target = await db
        .selectFrom('users')
        .select(['users.id'])
        .innerJoin('memberships', 'memberships.user_id', 'users.id')
        .where('users.id', '=', req.params.id)
        .where('users.deleted_at', 'is', null)
        .where('memberships.organization_id', '=', actor.organizationId)
        .executeTakeFirst();
      if (!target) throw new AppError('NOT_FOUND', 'user not found');
      await db.updateTable('users').set(req.body).where('id', '=', req.params.id).execute();
      await unitOfWork(db, async ({ tx }) => {
        await recordAudit(tx, {
          organization_id: actor.organizationId,
          actor_type: 'user',
          actor_id: actor.id,
          action: 'user.update',
          resource_type: 'user',
          resource_id: req.params.id,
          summary: { patch: req.body },
          request_id: actor.requestId,
        });
      });
      const u = await db.selectFrom('users').select(USER_COLUMNS).where('id', '=', req.params.id).executeTakeFirstOrThrow();
      return toUserDto(u as unknown as Record<string, unknown>);
    },
  );

  // Memberships: list & set a user's org role.
  t.get(
    '/api/v1/memberships',
    {
      schema: { response: { 200: z.object({ items: z.array(membershipSchema) }) } },
      preHandler: guard(db, { action: 'users:manage' }),
    },
    async (req) => {
      const actor = requireActor(req);
      const rows = await db
        .selectFrom('memberships')
        .select(['user_id', 'role'])
        .where('organization_id', '=', actor.organizationId)
        .execute();
      return { items: rows };
    },
  );

  t.post(
    '/api/v1/memberships',
    { schema: { body: membershipSchema, response: { 200: membershipSchema } }, preHandler: guard(db, { action: 'users:manage' }) },
    async (req) => {
      const actor = requireActor(req);
      await unitOfWork(db, async ({ tx }) => {
        const existing = await tx
          .selectFrom('memberships')
          .select('id')
          .where('organization_id', '=', actor.organizationId)
          .where('user_id', '=', req.body.user_id)
          .executeTakeFirst();
        if (existing) {
          await tx.updateTable('memberships').set({ role: req.body.role }).where('id', '=', existing.id).execute();
        } else {
          await tx
            .insertInto('memberships')
            .values({ id: newId(), organization_id: actor.organizationId, user_id: req.body.user_id, role: req.body.role })
            .execute();
        }
        await recordAudit(tx, {
          organization_id: actor.organizationId,
          actor_type: 'user',
          actor_id: actor.id,
          action: 'membership.upsert',
          resource_type: 'user',
          resource_id: req.body.user_id,
          summary: { role: req.body.role },
          request_id: actor.requestId,
        });
      });
      return req.body;
    },
  );
}

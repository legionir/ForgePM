import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createProjectSchema,
  updateProjectSchema,
  projectDtoSchema,
  listQuerySchema,
  paginatedResponseSchema,
  projectMemberSchema,
} from '@forgepm/shared';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { AppDeps } from '../../app/app';
import { guard, requireActor } from '../../app/guards';
import {
  archiveProject,
  createProject,
  getProject,
  listProjectsFor,
  patchProject,
  removeProject,
} from './service';
import { upsertProjectMember, listProjectMembers } from './members';

const idParams = z.object({ id: z.string().uuid() });
const projectResponse = { 200: projectDtoSchema, 201: projectDtoSchema };
const listResponse = paginatedResponseSchema(projectDtoSchema);

export function registerProjectsRoutes(app: FastifyInstance, deps: AppDeps): void {
  const t = app.withTypeProvider<ZodTypeProvider>();
  const db = deps.db;

  t.get(
    '/api/v1/projects',
    {
      schema: { querystring: listQuerySchema.extend({ include_archived: z.coerce.boolean().optional() }), response: { 200: listResponse } },
      preHandler: guard(db, {}),
    },
    async (req) =>
      listProjectsFor(db, requireActor(req), { limit: req.query.limit, cursor: req.query.cursor }, { includeArchived: req.query.include_archived }),
  );

  t.post(
    '/api/v1/projects',
    { schema: { body: createProjectSchema, response: projectResponse }, preHandler: guard(db, { action: 'project:create' }) },
    async (req, reply) => {
      const p = await createProject(db, requireActor(req), req.body);
      return reply.status(201).send(p);
    },
  );

  t.get(
    '/api/v1/projects/:id',
    { schema: { params: idParams, response: { 200: projectDtoSchema } }, preHandler: guard(db, {}) },
    async (req) => getProject(db, requireActor(req), req.params.id),
  );

  t.patch(
    '/api/v1/projects/:id',
    { schema: { params: idParams, body: updateProjectSchema, response: { 200: projectDtoSchema } }, preHandler: guard(db, {}) },
    async (req) => patchProject(db, requireActor(req), req.params.id, req.body),
  );

  t.delete(
    '/api/v1/projects/:id',
    { schema: { params: idParams }, preHandler: guard(db, {}) },
    async (req, reply) => {
      await removeProject(db, requireActor(req), req.params.id);
      return reply.status(204).send();
    },
  );

  t.post(
    '/api/v1/projects/:id/archive',
    { schema: { params: idParams, response: { 200: projectDtoSchema } }, preHandler: guard(db, {}) },
    async (req) => archiveProject(db, requireActor(req), req.params.id, true),
  );

  t.post(
    '/api/v1/projects/:id/unarchive',
    { schema: { params: idParams, response: { 200: projectDtoSchema } }, preHandler: guard(db, {}) },
    async (req) => archiveProject(db, requireActor(req), req.params.id, false),
  );

  // Members (plan §5.6). PUT replaces the member's role; GET lists members.
  t.get(
    '/api/v1/projects/:id/members',
    { schema: { params: idParams, response: { 200: z.object({ items: z.array(projectMemberSchema.extend({ email: z.string(), display_name: z.string() })) }) } }, preHandler: guard(db, {}) },
    async (req) => ({ items: await listProjectMembers(db, req.params.id, requireActor(req).organizationId) }),
  );

  t.put(
    '/api/v1/projects/:id/members/:userId',
    {
      schema: { params: z.object({ id: z.string().uuid(), userId: z.string().uuid() }), body: z.object({ role: projectMemberSchema.shape.role }) },
      preHandler: guard(db, {}),
    },
    async (req) => {
      await upsertProjectMember(db, requireActor(req), req.params.id, req.params.userId, req.body.role);
      return { status: 'ok' };
    },
  );
}

import { sql } from 'kysely';
import { newId, type DbLike } from '@forgepm/core';
import type { ProjectDto } from '@forgepm/shared';
import { AppError, listQuerySchema, decodeCursor, encodeCursor } from '@forgepm/shared';
import { cursorTs, rowCursorTs, tsParam } from '../../app/keyset';
import { z } from 'zod';

const PROJECT_COLUMNS = [
  'id',
  'organization_id',
  'key',
  'name',
  'description',
  'status',
  'priority',
  'start_date',
  'target_date',
  'archived_at',
  'created_at',
  'updated_at',
] as const;

export type ProjectRow = {
  [K in (typeof PROJECT_COLUMNS)[number]]: unknown;
} & { archived_at: Date | null; created_at: Date; updated_at: Date };

export function rowToProjectDto(r: ProjectRow): ProjectDto {
  return {
    id: r.id as string,
    organization_id: r.organization_id as string,
    key: r.key as string,
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    status: r.status as 'active' | 'archived',
    priority: r.priority as ProjectDto['priority'],
    start_date: r.start_date ? (r.start_date instanceof Date ? (r.start_date as Date).toISOString().slice(0, 10) : String(r.start_date)) : null,
    target_date: r.target_date ? (r.target_date instanceof Date ? (r.target_date as Date).toISOString().slice(0, 10) : String(r.target_date)) : null,
    archived_at: r.archived_at ? r.archived_at.toISOString() : null,
    created_at: (r.created_at as Date).toISOString(),
    updated_at: (r.updated_at as Date).toISOString(),
  };
}

export async function insertProject(
  db: DbLike,
  input: {
    organization_id: string;
    key: string;
    name: string;
    description?: string | null;
    priority?: 'none' | 'low' | 'medium' | 'high' | 'urgent';
    start_date?: string | null;
    target_date?: string | null;
  },
): Promise<string> {
  const id = newId();
  await db
    .insertInto('projects')
    .values({
      id,
      organization_id: input.organization_id,
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      priority: input.priority ?? 'none',
      start_date: input.start_date ?? null,
      target_date: input.target_date ?? null,
    })
    .execute();
  return id;
}

export async function findProjectById(db: DbLike, id: string, orgId: string): Promise<ProjectRow | undefined> {
  const r = await db
    .selectFrom('projects')
    .select(PROJECT_COLUMNS)
    .where('id', '=', id)
    .where('organization_id', '=', orgId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return r as ProjectRow | undefined;
}

export async function listProjects(
  db: DbLike,
  orgId: string,
  query: z.infer<typeof listQuerySchema>,
  includeArchived: boolean,
  visibility: { restrictToProjectIds: string[] | null } = { restrictToProjectIds: null },
): Promise<{ items: ProjectDto[]; next_cursor: string | null }> {
  let q = db
    .selectFrom('projects')
    .select(PROJECT_COLUMNS)
    .select(cursorTs())
    .where('organization_id', '=', orgId)
    .where('deleted_at', 'is', null);
  if (!includeArchived) q = q.where('status', '=', 'active');
  if (visibility.restrictToProjectIds) {
    q = q.where('id', 'in', visibility.restrictToProjectIds);
  }
  if (query.cursor) {
    const { createdAt, id } = decodeCursor(query.cursor);
    q = q.where((eb) =>
      eb.or([
        eb('created_at', '<', tsParam(createdAt)),
        eb.and([eb('created_at', '=', tsParam(createdAt)), eb('id', '<', id)]),
      ]),
    );
  }
  const rows = (await q
    .orderBy(sql`created_at DESC`)
    .orderBy(sql`id DESC`)
    .limit(query.limit + 1)
    .execute()) as unknown as ProjectRow[];
  const hasMore = rows.length > query.limit;
  const slice = hasMore ? rows.slice(0, query.limit) : rows;
  const items = slice.map(rowToProjectDto);
  const next_cursor = hasMore ? encodeCursor(rowCursorTs(slice[slice.length - 1]), slice[slice.length - 1].id as string) : null;
  return { items, next_cursor };
}

export async function updateProject(
  db: DbLike,
  id: string,
  orgId: string,
  patch: {
    name?: string;
    key?: string;
    description?: string | null;
    priority?: 'none' | 'low' | 'medium' | 'high' | 'urgent';
    status?: 'active' | 'archived';
    start_date?: string | null;
    target_date?: string | null;
    archived_at?: Date | null;
  },
): Promise<ProjectRow> {
  const set: Record<string, unknown> = { updated_at: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) set[k] = v;
  }
  const res = await db.updateTable('projects').set(set as never).where('id', '=', id).where('organization_id', '=', orgId).where('deleted_at', 'is', null).returning([...PROJECT_COLUMNS]).executeTakeFirst();
  if (!res) throw new AppError('NOT_FOUND', 'project not found');
  return res as unknown as ProjectRow;
}

export async function softDeleteProject(db: DbLike, id: string, orgId: string): Promise<void> {
  const res = await db
    .updateTable('projects')
    .set({ deleted_at: new Date(), updated_at: new Date() })
    .where('id', '=', id)
    .where('organization_id', '=', orgId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (Number(res.numUpdatedRows ?? 0n) === 0) throw new AppError('NOT_FOUND', 'project not found');
}


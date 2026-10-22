import { z } from 'zod';
import type { Db } from '@forgepm/core';
import type { Actor } from '../../app/auth-context';
import { parseTool, visibleProjects } from './context';

export const projectsToolSchema = z.strictObject({
  include_archived: z.boolean().default(false).describe('Also list archived projects (default false).'),
});

/**
 * `ledger_projects`: the projects this key can use, with the values to pass as `project_ref`.
 * It exists because a key limited to the ledger scopes cannot see `project_list`, so an agent
 * that does not know the project key had nothing to ask.
 */
export async function ledgerProjectsTool(db: Db, actor: Actor, raw: unknown): Promise<Record<string, unknown>> {
  const args = parseTool<{ include_archived: boolean }>(projectsToolSchema, raw, 'send {} or { include_archived: true }');
  const items = await visibleProjects(db, actor, { includeArchived: args.include_archived, limit: 200 });
  return {
    items,
    bound_to_project_ids: actor.projectIds ?? null,
    hint:
      items.length === 0
        ? 'no project is visible to this key; ask a human to create one or to widen the key'
        : 'pass a key (any letter case), an id or an exact unique name as project_ref; a key bound to a single project does not need it',
  };
}

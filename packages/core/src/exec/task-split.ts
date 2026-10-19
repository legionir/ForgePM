import { AppError, taskSplitInputSchema, type TaskSplitInput } from '@forgepm/shared';
import { findCycle } from '../graph';

export type TaskSplitValue = TaskSplitInput;

export function parseTaskSplit(raw: unknown): TaskSplitValue {
  const parsed = taskSplitInputSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError('VALIDATION_ERROR', `${issue?.path.join('.') || 'payload'}: ${issue?.message ?? 'invalid task split'}`, {
      needed_action: 'send a parent_ref and at least two children with checkable acceptance_criteria and allowed_paths',
    });
  }
  const keys = parsed.data.children.map((child) => child.key);
  if (new Set(keys).size !== keys.length) {
    throw new AppError('VALIDATION_ERROR', 'each child key must be unique within task_split');
  }
  const keySet = new Set(keys);
  const edges: [string, string][] = [];
  for (const child of parsed.data.children) {
    if (new Set(child.depends_on).size !== child.depends_on.length) {
      throw new AppError('VALIDATION_ERROR', `child '${child.key}' repeats a dependency`);
    }
    for (const dependency of child.depends_on) {
      if (keySet.has(dependency)) edges.push([child.key, dependency]);
    }
  }
  for (const key of keys) {
    const cycle = findCycle(edges, key);
    if (cycle) {
      throw new AppError('DEPENDENCY_CYCLE', `task split dependency cycle: ${cycle.join(' -> ')}`, {
        cycle,
        needed_action: 'remove a dependency edge so child tasks do not depend on each other in a loop',
      });
    }
  }
  return parsed.data;
}

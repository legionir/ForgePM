import { z } from 'zod';
import { WORK_ITEM_TYPES, PRIORITIES, STATE_CATEGORIES, WORK_ITEM_SOURCES } from './enums';

/** Acceptance criteria item (plan §6.1): tickable. */
export const acceptanceCriterionSchema = z.object({ text: z.string().min(1).max(1000), done: z.boolean().default(false) });
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;

export const DEFAULT_WORKFLOW: { name: string; category: (typeof STATE_CATEGORIES)[number] }[] = [
  { name: 'Backlog', category: 'backlog' },
  { name: 'Todo', category: 'unstarted' },
  { name: 'In Progress', category: 'started' },
  { name: 'In Review', category: 'in_review' },
  { name: 'Done', category: 'completed' },
  { name: 'Canceled', category: 'canceled' },
];

export const createWorkItemSchema = z.object({
  type: z.enum(WORK_ITEM_TYPES),
  title: z.string().min(1).max(500),
  description: z.string().max(50_000).optional(),
  state_id: z.string().uuid(),
  priority: z.enum(PRIORITIES).optional(),
  assignee_user_id: z.string().uuid().nullable().optional(),
  assignee_agent_id: z.string().uuid().nullable().optional(),
  estimate: z.number().nullable().optional(),
  due_date: z.string().date().nullable().optional(),
  parent_id: z.string().uuid().nullable().optional(),
  feature_id: z.string().uuid().nullable().optional(),
  milestone_id: z.string().uuid().nullable().optional(),
  acceptance_criteria: z.array(acceptanceCriterionSchema).optional(),
  labels: z.array(z.string()).optional(),
  source: z.enum(WORK_ITEM_SOURCES).optional(),
  plan_id: z.string().uuid().nullable().optional(),
});
export type CreateWorkItemInput = z.infer<typeof createWorkItemSchema>;

export const updateWorkItemSchema = createWorkItemSchema.partial().omit({ source: true, plan_id: true });

export const transitionSchema = z.object({ to_state_id: z.string().uuid() });

export const workItemDtoSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  project_id: z.string().uuid(),
  project_key: z.string(),
  number: z.number(),
  key: z.string(),
  type: z.enum(WORK_ITEM_TYPES),
  title: z.string(),
  description: z.string().nullable(),
  state_id: z.string().uuid(),
  state_name: z.string(),
  state_category: z.enum(STATE_CATEGORIES),
  priority: z.enum(PRIORITIES),
  assignee_user_id: z.string().nullable(),
  assignee_agent_id: z.string().nullable(),
  reporter_id: z.string().nullable(),
  estimate: z.string().nullable(),
  due_date: z.string().nullable(),
  parent_id: z.string().nullable(),
  feature_id: z.string().nullable(),
  milestone_id: z.string().nullable(),
  acceptance_criteria: z.array(acceptanceCriterionSchema),
  source: z.enum(WORK_ITEM_SOURCES),
  plan_id: z.string().nullable(),
  labels: z.array(z.string()),
  created_at: z.string(),
  updated_at: z.string(),
});
export type WorkItemDto = z.infer<typeof workItemDtoSchema>;

export const workItemFilterSchema = z.object({
  state_id: z.string().uuid().optional(),
  state_category: z.enum(STATE_CATEGORIES).optional(),
  type: z.enum(WORK_ITEM_TYPES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  assignee_user_id: z.string().uuid().optional(),
  assignee_agent_id: z.string().uuid().optional(),
  label: z.string().optional(),
  feature_id: z.string().uuid().optional(),
  milestone_id: z.string().uuid().optional(),
  due_before: z.string().date().optional(),
  due_after: z.string().date().optional(),
  q: z.string().max(200).optional(),
});
export type WorkItemFilter = z.infer<typeof workItemFilterSchema>;

export const relationSchema = z.object({ to_key: z.string(), type: z.enum(['blocks', 'relates_to', 'duplicates']) });

export const commentSchema = z.object({
  body: z.string().min(1).max(20_000),
  kind: z.enum(['comment', 'ai_report']).optional(),
});

export const featureSchema = z.object({
  key: z.string().min(1).max(16),
  title: z.string().min(1).max(200),
  description: z.string().max(50_000).optional(),
  acceptance_criteria: z.array(acceptanceCriterionSchema).optional(),
  target_release: z.string().max(64).nullable().optional(),
  milestone_id: z.string().uuid().nullable().optional(),
});
export const updateFeatureSchema = featureSchema.partial().extend({
  lifecycle_status: z.enum(['proposed', 'planned', 'in_progress', 'in_validation', 'released', 'deprecated']).optional(),
});

export const featureDtoSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  project_id: z.string().uuid(),
  key: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  lifecycle_status: z.enum(['proposed', 'planned', 'in_progress', 'in_validation', 'released', 'deprecated']),
  target_release: z.string().nullable(),
  milestone_id: z.string().nullable(),
  acceptance_criteria: z.array(acceptanceCriterionSchema),
  work_progress: z.number(),
  release_readiness: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type FeatureDto = z.infer<typeof featureDtoSchema>;

export const milestoneSchema = z.object({
  name: z.string().min(1).max(200),
  target_date: z.string().date().nullable().optional(),
});
export const milestoneDtoSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  project_id: z.string().uuid(),
  name: z.string(),
  target_date: z.string().nullable(),
  status: z.enum(['open', 'closed']),
  progress: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type MilestoneDto = z.infer<typeof milestoneDtoSchema>;

export const labelSchema = z.object({ name: z.string().min(1).max(60), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) });

export const savedViewSchema = z.object({
  project_id: z.string().uuid(),
  name: z.string().min(1).max(120),
  filter: workItemFilterSchema,
  shared: z.boolean().optional(),
});

export const bulkCreateSchema = z.object({
  project_id: z.string().uuid().optional(),
  items: z.array(createWorkItemSchema).min(1).max(100),
  idempotency_key: z.string().min(1).max(200),
});

export const externalLinkSchema = z.object({
  kind: z.enum(['pr', 'commit', 'branch', 'issue', 'url']),
  external_id: z.string().min(1).max(200),
  url: z.string().url().max(2000),
});

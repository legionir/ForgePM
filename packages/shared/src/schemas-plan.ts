import { z } from 'zod';
import { PLAN_STATUSES } from './enums';

/**
 * Planner structured output (plan §7.3). milestones[] <- features[] <-
 * work_items[] with temp_id/depends_on/acceptance_criteria/estimate/risk and
 * open_questions[].
 */
export const planWorkItemSchema = z.object({
  temp_id: z.string().min(1).max(64),
  title: z.string().min(1).max(500),
  type: z.enum(['task', 'bug', 'feature_task', 'improvement', 'refactor', 'research', 'chore']),
  priority: z.enum(['none', 'low', 'medium', 'high', 'urgent']).default('medium'),
  description: z.string().max(20_000).optional(),
  estimate: z.number().nullable().optional(),
  risk: z.string().max(500).optional(),
  depends_on: z.array(z.string()).default([]),
  acceptance_criteria: z.array(z.object({ text: z.string().min(1), done: z.boolean().default(false) })).default([]),
});

export const planFeatureSchema = z.object({
  temp_id: z.string().min(1).max(64),
  key: z.string().min(1).max(16),
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).optional(),
  target_release: z.string().max(64).optional(),
  milestone_temp_id: z.string().max(64).optional(),
  acceptance_criteria: z.array(z.object({ text: z.string().min(1), done: z.boolean().default(false) })).min(1),
  work_items: z.array(planWorkItemSchema).default([]),
});

export const planMilestoneSchema = z.object({
  temp_id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  target_date: z.string().date().optional(),
  features: z.array(planFeatureSchema).default([]),
});

export const planContentSchema = z.object({
  milestones: z.array(planMilestoneSchema).default([]),
  // top-level features not nested under a milestone are allowed too
  features: z.array(planFeatureSchema).default([]),
  work_items: z.array(planWorkItemSchema).default([]),
  open_questions: z.array(z.string().max(1000)).default([]),
});
export type PlanContent = z.infer<typeof planContentSchema>;
export type PlanWorkItem = z.infer<typeof planWorkItemSchema>;
export type PlanFeature = z.infer<typeof planFeatureSchema>;
export type PlanMilestone = z.infer<typeof planMilestoneSchema>;

export const planStatusSchema = z.enum(PLAN_STATUSES);

export const validationReportSchema = z.object({
  ok: z.boolean(),
  cycles: z.array(z.array(z.string())).default([]),
  duplicate_temp_ids: z.array(z.string()).default([]),
  duplicate_titles: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  item_count: z.number().int().default(0),
});
export type ValidationReport = z.infer<typeof validationReportSchema>;

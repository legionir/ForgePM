import { createHash } from 'node:crypto';
import { z } from 'zod';
import { planContentSchema, planStatusSchema, type PlanContent, type PlanStatus, type ValidationReport } from '@forgepm/shared';

/** Public API surface of the planner module (REST, MCP and worker all use it). */
export const createPlanInputSchema = z.object({
  goal: z.string().min(1).max(4000),
  constraints: z.string().max(4000).optional(),
});

export const planContentDtoSchema = z.object({
  content: planContentSchema,
  validation: z.custom<ValidationReport>().optional(),
  status: planStatusSchema,
  revision_no: z.number().int(),
  open_questions: z.array(z.string()),
});
export type PlanContentDto = z.infer<typeof planContentDtoSchema>;

export const planDtoSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  project_id: z.string().uuid(),
  goal: z.string(),
  status: planStatusSchema,
  current_revision_id: z.string().nullable(),
  created_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type PlanDto = z.infer<typeof planDtoSchema>;

export type { PlanContent, PlanStatus, ValidationReport };

/** Hash used to compare two revision contents (immutable, deterministic). */
export function revisionHash(content: PlanContent): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

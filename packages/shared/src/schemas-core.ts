import { z } from 'zod';
import { ORG_ROLES, PROJECT_ROLES, API_KEY_SCOPES, PRIORITIES } from './enums';

/**
 * Cross-surface domain schemas (plan §3: one shared Zod schema set for REST,
 * MCP and the panel). Phase 1: identity, projects, API keys, settings.
 */

export const projectKeySchema = z.string().regex(/^[A-Z]{3,5}$/, 'project key must be 3-5 uppercase letters');

export const createProjectSchema = z.object({
  key: projectKeySchema,
  name: z.string().min(1).max(200),
  description: z.string().max(20_000).optional(),
  priority: z.enum(PRIORITIES).optional(),
  start_date: z.string().date().nullable().optional(),
  target_date: z.string().date().nullable().optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = createProjectSchema
  .partial()
  .extend({ status: z.enum(['active', 'archived']).optional() });
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const projectDtoSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.enum(['active', 'archived']),
  priority: z.enum(PRIORITIES),
  start_date: z.string().nullable(),
  target_date: z.string().nullable(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ProjectDto = z.infer<typeof projectDtoSchema>;

export const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(512),
});

export const setupSchema = z.object({
  organization_name: z.string().min(1).max(200),
  admin_email: z.string().email().max(320),
  admin_password: z.string().min(8).max(512),
  admin_display_name: z.string().min(1).max(200),
});

export const createUserSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(512),
  display_name: z.string().min(1).max(200),
  locale: z.enum(['en', 'fa']).optional(),
  timezone: z.string().min(1).max(64).optional(),
});

export const updateUserSchema = z.object({
  display_name: z.string().min(1).max(200).optional(),
  locale: z.enum(['en', 'fa']).optional(),
  timezone: z.string().min(1).max(64).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

export const membershipSchema = z.object({
  user_id: z.string().uuid(),
  role: z.enum(ORG_ROLES),
});

export const projectMemberSchema = z.object({
  user_id: z.string().uuid(),
  role: z.enum(PROJECT_ROLES),
});

export const userDtoSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  display_name: z.string(),
  locale: z.enum(['en', 'fa']),
  timezone: z.string(),
  status: z.enum(['active', 'disabled']),
  created_at: z.string(),
});
export type UserDto = z.infer<typeof userDtoSchema>;

export const createApiKeySchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1),
  project_ids: z.array(z.string().uuid()).optional(),
  expires_at: z.string().datetime().nullable().optional(),
  agent_id: z.string().uuid().optional(),
});

export const apiKeyDtoSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  project_ids: z.array(z.string()),
  owner_user_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  expires_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  created_at: z.string(),
});
export type ApiKeyDto = z.infer<typeof apiKeyDtoSchema>;

export const createAgentSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
});

export const settingValueSchema = z.object({ value: z.unknown() });

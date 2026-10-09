/**
 * Cross-cutting enums (plan §1). These are the only source of truth for
 * API, MCP and the panel.
 */
export const WORK_ITEM_TYPES = ['task', 'bug', 'feature_task', 'improvement', 'refactor', 'research', 'chore'] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

export const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const STATE_CATEGORIES = ['backlog', 'unstarted', 'started', 'in_review', 'completed', 'canceled'] as const;
export type StateCategory = (typeof STATE_CATEGORIES)[number];

export const ACTOR_TYPES = ['user', 'agent', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const ORG_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const PROJECT_ROLES = ['lead', 'contributor', 'viewer'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const WORK_ITEM_SOURCES = ['manual', 'planner', 'code_review', 'refactor_review', 'github'] as const;
export type WorkItemSource = (typeof WORK_ITEM_SOURCES)[number];

export const APPROVAL_POLICIES = ['manual', 'auto_low_risk'] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

export const REVIEW_ISSUE_POLICIES = ['record_only', 'human_approval', 'auto_high_severity'] as const;
export type ReviewIssuePolicy = (typeof REVIEW_ISSUE_POLICIES)[number];

export const API_KEY_SCOPES = ['read', 'write', 'plan', 'plan_approve', 'plan_apply', 'review', 'github', 'admin'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'dead'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const PLAN_STATUSES = [
  'generating',
  'needs_clarification',
  'ready',
  'approved',
  'applying',
  'applied',
  'generation_failed',
  'apply_failed',
  'canceled',
  'superseded',
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const FINDING_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_STATUSES = ['open', 'dismissed', 'accepted', 'issue_created', 'not_seen', 'fixed'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

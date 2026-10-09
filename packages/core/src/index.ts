// @forgepm/core — infrastructure shared by api and worker.
// Raw DB/Redis access lives ONLY here (plan §3b-2).
export * from './env';
export * from './logging';
export * from './crypto';
export * from './id';
export { toJsonb } from './jsonb';
export * from './db/types';
export {
  createDb,
  migrationsFromSql,
  createMigrator,
  runMigrations,
  pingDb,
} from './db/client';
export { migrations } from './db/migrations/index';
export type { Db, Tx, DbLike } from './db/unitOfWork';
export { unitOfWork, appendOutbox, type UnitOfWorkContext, type OutboxMessage } from './db/unitOfWork';
export { scopedDb, withOrg, type ScopedDb, type RequestCtx } from './db/scoped';
export {
  getEffective,
  upsertSetting,
  deleteSetting,
  type EffectiveSetting,
  type SettingsScope,
} from './settings';
export {
  SETTING_DEFINITIONS,
  isKnownSettingKey,
  findSettingDefinition,
  validateSettingValue,
  settingDefault,
  type SettingDefinition,
} from './settings-registry';
export { recordAudit, SYSTEM_ACTOR_ID, type AuditRecord } from './audit';
export {
  putSecret,
  getSecret,
  findSecretByName,
  deleteSecret,
  type SecretMeta,
} from './secrets';
export {
  applyPullRequestEvent,
  normalizePullRequestPayload,
  importIssueEvent,
  normalizeIssuePayload,
  recordRelease,
  upsertRepo,
  deliveryRow,
  markDeliveryDone,
  extractItemKeys,
  extractClosingKeys,
  type PullRequestEventData,
  type IssueEventData,
} from './github/delivery';
export { can, authorize, type Action, type ActorAccess } from './permissions/matrix';
export {
  generateApiKey,
  hashApiKey,
  verifyApiKey,
  generateSessionToken,
  generateCsrfToken,
  type GeneratedApiKey,
} from './auth/crypto';
export {
  requestHash,
  beginIdempotency,
  storeIdempotencyResult,
  abandonIdempotency,
  type IdempotencyOutcome,
} from './idempotency';
export { findCycle, workProgress, releaseReadiness, TERMINAL_CATEGORIES, type CategoryCounts } from './graph';
export { validatePlan, similarity } from './planner/validate';
export {
  estimateTokens,
  ProviderError,
  type AiProvider,
  type GenerateRequest,
  type GenerateResult,
} from './ai/provider';
export { buildProvider, FakeProvider, OpenAiCompatibleProvider, AnthropicProvider } from './ai/providers';
export { tokensUsedToday } from './ai/budget';
export { canTransition, nextStatus, isTerminal, type PlanEvent } from './planner/state';
export { revisionHash, createPlanInputSchema, planDtoSchema, planContentDtoSchema } from './planner/types';
export {
  ToolRegistry,
  maskInput,
  capOutput,
  MCP_MAX_OUTPUT_BYTES,
  type McpToolDefinition,
  type McpCallContext,
  type McpActor,
  type AnyTool,
  type ToolAnnotations,
} from './mcp/registry';
export {
  ModuleRegistry,
  makeRequireModule,
  type ModuleDefinition,
  type ModuleName,
} from './modules/registry';
export {
  createRedis,
  createQueues,
  QUEUES,
  OUTBOX_DISPATCH_JOB,
  type QueueName,
} from './queue/client';

// @forgepm/core — infrastructure shared by api and worker.
// Raw DB/Redis access lives ONLY here (plan §3b-2).
export * from './env';
export * from './logging';
export * from './crypto';
export {
  MetricsRegistry,
  defaultRegistry,
  type Labels,
} from './metrics';
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
  isReviewKeyRedeclaration,
  type SettingDefinition,
} from './settings-registry';
export { recordAudit, SYSTEM_ACTOR_ID, type AuditRecord } from './audit';
export {
  runRetention,
  RETENTION_KEYS,
  type RetentionKey,
  type RetentionResult,
} from './retention';
export {
  putSecret,
  getSecret,
  findSecretByName,
  deleteSecret,
  type SecretMeta,
} from './secrets';
export { rotateDbSecrets, type RotationResult } from './rotate';
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
export {
  REVIEW_SEVERITIES,
  SEVERITY_ORDER,
  REVIEW_RUN_STATUSES,
  REVIEW_FINDING_STATUSES,
  hunkSchema,
  snapshotFileSchema,
  reviewInputSchema,
  rawFindingSchema,
  reviewStageOutputSchema,
  normalizeWs,
  normalizeTitle,
  computeFingerprint,
  codeScopeKey,
  repoScopeKey,
  matchGlob,
  isIgnored,
  type ReviewSeverity,
  type ReviewRunStatus,
  type ReviewFindingStatus,
  type Hunk,
  type SnapshotFile,
  type ReviewInput,
  type RawFinding,
  type ReviewStageOutput,
  type ReviewConfig,
} from './review/contract';
export { validateEvidence, partitionFindingWrites } from './review/validate';
export { setReviewProviderResolver, resolveReviewProvider, type ReviewProviderResolver } from './review/provider-slot';
export { StubProvider } from './review/stub-provider';
export { dbReviewProvider } from './review/db-provider';
export { setDiffProvider, diffProvider, type DiffProvider } from './review/diff-slot';
export { setRepoFetcher, githubFiles, withStagedRepo, assertUnderRoot, incrementalScope, type RepoFetcher } from './review/sources';
export {
  upsertFindings,
  sweepNotSeen,
  shouldCreateWorkItem,
  loadFinding,
  createWorkItemFromFinding,
  updateFindingStatus,
  requestFindingApproval,
  hasApprovedFindingRequest,
  effectiveIssuePolicy,
  fingerprintFor,
  type FindingRow,
} from './review/findings';
export { resolveReviewConfig } from './review/config';
export {
  executeReviewRun,
  createRun,
  defaultStages,
  getRunReport,
  runCodeReviewForPr,
  setReviewOutputWriter,
  type ReviewOutputWriter,
  DEFAULT_CODE_STAGES,
  DEFAULT_REFACTOR_STAGES,
  type ReviewStage,
  type RunInput,
  type RunOutcome,
  type ExecuteArgs,
} from './review/engine';
export {
  analyzeRepoFiles,
  structureIndexJson,
  partitionFiles,
  selectFiles,
  findDuplicates,
  buildImportGraph,
  extractFunctions,
  isCodeFile,
  type AnalyzerFile,
  type StructureIndex,
  type FunctionMetric,
  type DupBlock,
  type ImportGraph,
} from './review/analyzer';
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
  isModuleEnabled,
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

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

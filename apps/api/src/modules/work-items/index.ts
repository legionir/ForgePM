// work-items module public surface (plan §3: modules talk via index.ts only).
export {
  createWorkItem,
  patchWorkItem,
  transitionWorkItem,
  softDelete,
  addRelation,
  bulkCreate,
  listFor,
  search,
  reload,
} from './service';
export { featureStateCounts, milestoneStateCounts } from './items-repository';
export { listStates, getState, ensureWorkflow, createState } from './states';

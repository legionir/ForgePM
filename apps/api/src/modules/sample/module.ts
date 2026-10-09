import type { ModuleDefinition } from '@forgepm/core';

/**
 * Sample module definition (plan §4.4, §4.6). validateConfig proves enable
 * can be rejected before flipping the flag; for Phase 0 it always succeeds.
 */
export const sampleModule: ModuleDefinition = {
  name: 'sample',
  validateConfig: async () => {
    // No config needed for the sample; keep it always valid.
  },
};

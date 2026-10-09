import type { ModuleDefinition } from '@forgepm/core';

/**
 * The github module is ALWAYS registered (plan §3b-1.1). Enabled state is a
 * runtime setting (`modules.github.enabled`), NOT this definition. validateConfig
 * runs on enable (plan §3b-1.4) and requires the App id + private key +
 * webhook secret to be present in the `secrets` table or bootstrap env.
 */
export const githubModule: ModuleDefinition = {
  name: 'github',
  // validateConfig is provided by the routes module (needs db); see setGhValidate.
};

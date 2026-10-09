import type { ModuleDefinition } from '@forgepm/core';

/**
 * Code Review + Refactor Review are ALWAYS registered (plan §3b-1.1, §10).
 * Enabled state is a runtime setting (`modules.code_review.enabled`,
 * `modules.refactor_review.enabled`), both default false. No validateConfig:
 * enabling needs no secrets — a run additionally needs a configured AI
 * provider, which is checked when the run starts, not at enable time.
 */
export const codeReviewModule: ModuleDefinition = { name: 'code_review' };
export const refactorReviewModule: ModuleDefinition = { name: 'refactor_review' };

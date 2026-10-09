import { defineWorkspace } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Coverage instruments source (not built dist): map workspace packages to src.
const alias = {
  '@forgepm/shared': r('./packages/shared/src/index.ts'),
  '@forgepm/core': r('./packages/core/src/index.ts'),
};

export default defineWorkspace([
  {
    resolve: { alias },
    test: {
      name: 'unit',
      environment: 'node',
      include: ['packages/**/*.test.ts', 'tests/unit/**/*.test.ts', 'apps/api/test/unit/**/*.test.ts', 'apps/worker/test/unit/**/*.test.ts'],
    },
  },
  {
    resolve: { alias },
    test: {
      name: 'integration',
      environment: 'node',
      fileParallelism: false,
      testTimeout: 60_000,
      hookTimeout: 60_000,
      include: ['tests/integration/**/*.test.ts', 'apps/api/test/integration/**/*.test.ts', 'apps/worker/test/integration/**/*.test.ts'],
    },
  },
]);

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Coverage instruments SOURCE, not built dist: workspace packages are aliased
 * to their src/ entry points (vitest resolves TS sources on the fly).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@forgepm/shared': r('./packages/shared/src/index.ts'),
      '@forgepm/core': r('./packages/core/src/index.ts'),
    },
  },
  test: {
    coverage: {
      enabled: false,
      provider: 'v8',
      all: true,
      include: ['packages/*/src/**', 'apps/api/src/**', 'apps/worker/src/**'],
      exclude: ['**/*.test.ts', '**/main.ts', '**/dist/**', '**/index.ts', '**/types.ts', '**/*.migration.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 80, functions: 80, branches: 70 },
    },
  },
});

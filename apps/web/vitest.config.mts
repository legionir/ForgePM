import { defineConfig } from 'vitest/config';

/**
 * runnerConfig for `ng test` (@angular/build:unit-test). The Angular builder
 * owns the Angular transform + jsdom environment; this file only narrows the
 * discovery globs (e2e/*.spec.ts are Playwright, NOT unit tests). Coverage
 * scope + ≥80% thresholds live in angular.json (builder-native enforcement).
 */
export default defineConfig({
  test: {
    include: ['src/**/*.{spec,test}.ts', 'test/**/*.test.ts'],
  },
});

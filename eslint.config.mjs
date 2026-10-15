// @ts-check
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';

/**
 * Flat config. Two architectural rules the plan requires to FAIL on a
 * forbidden sample (acceptance §4):
 *   1. Raw DB/queue access (pg, kysely, ioredis, bullmq) is confined to
 *      @forgepm/core (infrastructure) + the app bootstrap; feature modules
 *      and repositories must not reach for a raw connection.
 *   2. Module boundaries: a module may not import another module's
 *      `repository` (layering is repository ← service ← routes within a
 *      module; cross-module calls go through the other module's service).
 */
export default [
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: { process: 'readonly', Buffer: 'readonly', globalThis: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', console: 'readonly', URL: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly', NodeJS: 'readonly', fetch: 'readonly', AbortController: 'readonly' },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      import: importPlugin,
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always'],
      'import/no-default-export': 'off',
    },
  },

  // Node ESM scripts (.mjs) need Node globals.
  {
    files: ['scripts/**/*.mjs', 'apps/web/scripts/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: { process: 'readonly', console: 'readonly' },
    },
  },

  // Playwright specs run in Node but assert inside the browser context
  // (page.evaluate), so DOM globals are legitimate here.
  {
    files: ['apps/web/e2e/**/*.ts'],
    languageOptions: {
      globals: {
        document: 'readonly', window: 'readonly', localStorage: 'readonly',
      },
    },
    rules: { 'no-undef': 'off' },
  },

  // Angular panel (apps/web): browser globals + DOM types; the TS compiler
  // owns undefined-identifier checks, so no-undef is off here (ENF-002 —
  // the panel is NO LONGER excluded from the root lint gate).
  {
    files: ['apps/web/src/**/*.ts'],
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: {
        document: 'readonly', window: 'readonly', localStorage: 'readonly',
        matchMedia: 'readonly', location: 'readonly', navigator: 'readonly',
        Event: 'readonly', DragEvent: 'readonly', KeyboardEvent: 'readonly',
        ClipboardEvent: 'readonly', CustomEvent: 'readonly', DataTransfer: 'readonly',
        HTMLElement: 'readonly', HTMLInputElement: 'readonly',
        HTMLSelectElement: 'readonly', HTMLTextAreaElement: 'readonly',
        MediaQueryList: 'readonly', MediaQueryListEvent: 'readonly',
        getComputedStyle: 'readonly', requestAnimationFrame: 'readonly',
        fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
        Headers: 'readonly', Request: 'readonly', Response: 'readonly',
        FormData: 'readonly', AbortController: 'readonly', setTimeout: 'readonly',
        clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
      },
    },
    rules: {
      'no-undef': 'off',
    },
  },

  // Rule 1 — raw DB/queue CLIENT connections forbidden in feature modules.
  // Repositories/services may still compose queries with the `kysely`
  // builder; they MUST NOT open their own pg/ioredis/bullmq connections.
  {
    files: ['apps/api/src/modules/**/*.ts', 'apps/worker/src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'pg', message: 'Raw DB access belongs in @forgepm/core (infrastructure) only.' },
            { name: 'ioredis', message: 'Redis/queue access belongs in @forgepm/core (infrastructure) only.' },
            { name: 'bullmq', message: 'Queue access belongs in @forgepm/core (infrastructure) only.' },
          ],
          patterns: [
            {
              group: ['../**/repository', '../**/repository.*'],
              message: 'Cross-module import forbidden: import a module via its service, never its repository (plan §3).',
            },
          ],
        },
      ],
    },
  },

  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.migration.ts', // SQL contract, excluded from size/generated rules
      'tests/schema-snapshots/**',
      'tests/lint-fixtures/**', // deliberately-violating samples, linted by a dedicated test
      '**/*.d.ts',
      // apps/web is intentionally NOT ignored (ENF-002): the Angular panel is
      // linted by the root gate via the browser-globals block above. It keeps
      // its own TS major, build and E2E gates (apps/web/e2e.sh).
    ],
  },
];

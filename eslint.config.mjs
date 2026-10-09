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
      globals: { process: 'readonly', Buffer: 'readonly', globalThis: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', console: 'readonly', URL: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly', NodeJS: 'readonly' },
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
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: { process: 'readonly', console: 'readonly' },
    },
  },

  // Rule 1 — raw DB/queue connection forbidden in feature modules.
  // The worker's queue infrastructure (dispatcher/sweeper/handlers/main) is
  // the BullMQ consumer and MAY own the connection; feature modules may not.
  {
    files: ['apps/api/src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'pg', message: 'Raw DB access belongs in @forgepm/core (infrastructure) only.' },
            { name: 'kysely', message: 'Raw DB access belongs in @forgepm/core (infrastructure) only.' },
            { name: 'ioredis', message: 'Redis/queue access belongs in @forgepm/core (infrastructure) only.' },
            { name: 'bullmq', message: 'Queue access belongs in @forgepm/core (infrastructure) only.' },
          ],
        },
      ],
    },
  },

  // Rule 2 — a module must not import another module's repository.
  {
    files: ['apps/api/src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/repository', '**/repository.*'],
              message: 'Cross-layer import forbidden: import a module via its service, never its repository (plan §3).',
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
    ],
  },
];

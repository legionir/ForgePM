// @ts-check
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  js.configs.recommended,
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        process: 'readonly', console: 'readonly', URL: 'readonly',
        setInterval: 'readonly', setTimeout: 'readonly',
        clearInterval: 'readonly', clearTimeout: 'readonly',
      },
    },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: {
        console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly', fetch: 'readonly',
        URL: 'readonly', document: 'readonly', localStorage: 'readonly',
        Event: 'readonly', DragEvent: 'readonly', HTMLSelectElement: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      'no-unused-vars': 'off',
      // TypeScript owns undefined-name checks, including DOM and Vitest globals.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  { ignores: ['.angular/**', 'dist/**', 'node_modules/**', '*.d.ts'] },
];

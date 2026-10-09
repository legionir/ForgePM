import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import * as tsParser from '@typescript-eslint/parser';
import { fileURLToPath } from 'node:url';

/**
 * Acceptance §4: "قاعده‌های ESLint (مرز ماژول‌ها، اتصال خام DB) با
 * نمونه‌ی ممنوع آزمایشی خطا می‌دهند" — the forbidden samples under
 * tests/lint-fixtures/ MUST produce lint errors under the architectural rules.
 */
const fixtureRaw = fileURLToPath(new URL('../lint-fixtures/raw-db-in-module.ts', import.meta.url));
const fixtureCross = fileURLToPath(new URL('../lint-fixtures/cross-module-repository.ts', import.meta.url));

const RESTRICTED_PATHS = ['pg', 'kysely', 'ioredis', 'bullmq'].map((name) => ({
  name,
  message: `Raw ${name} access forbidden outside infrastructure.`,
}));

async function lintWith(file: string, rules: Record<string, unknown>) {
  const eslint = new ESLint({
    overrideConfigFile: true as never,
    overrideConfig: [
      {
        files: ['**/*.ts'],
        languageOptions: {
          parser: tsParser as never,
          parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
        },
        rules,
      },
    ] as never,
    // fixtures are excluded from the project config; bypass ignore rules here
    ignore: false,
  });
  const results = await eslint.lintFiles([file]);
  return results.flatMap((r) => r.messages.map((m) => ({ ruleId: m.ruleId, message: m.message })));
}

describe('ESLint architectural boundary rules', () => {
  it('flags raw DB/queue imports (Rule 1)', async () => {
    const messages = await lintWith(fixtureRaw, {
      'no-restricted-imports': ['error', { paths: RESTRICTED_PATHS }],
    });
    const rules = messages.map((m) => m.ruleId);
    expect(rules).toContain('no-restricted-imports');
    // pg, kysely and bullmq all imported in the fixture
    const flagged = messages.filter((m) => m.ruleId === 'no-restricted-imports');
    expect(flagged.length).toBeGreaterThanOrEqual(3);
  });

  it('flags importing another module\'s repository (Rule 2)', async () => {
    const messages = await lintWith(fixtureCross, {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/projects/repository', '**/projects/repository.*'], message: 'Cross-module repository import forbidden.' }] },
      ],
    });
    expect(messages.map((m) => m.ruleId)).toContain('no-restricted-imports');
  });
});

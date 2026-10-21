import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = join(ROOT, 'scripts', 'claude-hook.mjs');

type HookOutput = {
  hookSpecificOutput?: {
    hookEventName: string;
    permissionDecision: 'ask' | 'deny';
    permissionDecisionReason: string;
  };
};

function runHook(raw: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(raw);
  });
}

async function runInput(input: unknown): Promise<HookOutput> {
  const result = await runHook(JSON.stringify(input));
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as HookOutput;
}

describe('Claude Code PreToolUse policy hook (PE-5 F.9)', () => {
  it('asks before Bash git push', async () => {
    const output = await runInput({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
    });
    expect(output.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
    });
  });

  it('denies recursive forced deletion', async () => {
    const output = await runInput({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf ./build' },
    });
    expect(output.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
    });
  });

  it('asks before editing any package.json', async () => {
    const output = await runInput({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: 'packages/core/package.json', old_string: 'a', new_string: 'b' },
    });
    expect(output.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
    });
  });

  it.each([
    ['Write', 'package.json'],
    ['MultiEdit', 'apps/web/package.json'],
    ['Edit', '.claude/settings.json'],
    ['Write', 'scripts/hooks/ledger-stop.mjs'],
    ['Write', '.env'],
  ])('asks before %s of the guarded file %s', async (tool_name, file_path) => {
    const output = await runInput({ hook_event_name: 'PreToolUse', tool_name, tool_input: { file_path } });
    expect(output.hookSpecificOutput).toMatchObject({ permissionDecision: 'ask' });
  });

  it('lets .env.example and ordinary source files through', async () => {
    for (const file_path of ['.env.example', 'apps/api/src/app.ts']) {
      const output = await runInput({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path } });
      expect(output).toEqual({});
    }
  });

  it('passes unrelated tools with an empty JSON response', async () => {
    const output = await runInput({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git status --short' },
    });
    expect(output).toEqual({});
  });

  it('fails closed on malformed hook JSON', async () => {
    const result = await runHook('{not-json');
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    });
  });
});

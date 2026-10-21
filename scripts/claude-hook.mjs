#!/usr/bin/env node
import { posix as posixPath, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EVENT = 'PreToolUse';

function decision(permissionDecision, permissionDecisionReason) {
  return {
    hookSpecificOutput: {
      hookEventName: EVENT,
      permissionDecision,
      permissionDecisionReason,
    },
  };
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asksForRecursiveDelete(command) {
  const rm = /(?:^|[;&|\s])(?:sudo\s+)?rm\s+(-[a-z]+)(?=\s|$)/gim;
  for (const match of command.matchAll(rm)) {
    const flags = (match[1] ?? '').toLowerCase();
    if (flags.includes('r') && flags.includes('f')) return true;
  }
  return false;
}

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

/** What a human must approve before the agent changes it: manifests, secrets, the guard rails themselves. */
function guardedFileReason(filePath) {
  if (typeof filePath !== 'string') return null;
  const normalized = filePath.replaceAll('\\', '/');
  const base = posixPath.basename(normalized);
  if (base === 'package.json') return 'editing package.json requires explicit human approval';
  if (base === '.env' || (base.startsWith('.env.') && base !== '.env.example')) {
    return 'editing an environment file requires explicit human approval';
  }
  if (/(^|\/)\.claude\/settings(\.local)?\.json$/.test(normalized) || /(^|\/)scripts\/hooks\//.test(normalized)) {
    return 'editing the agent guard rails requires explicit human approval';
  }
  return null;
}

/** Return a Claude Code PreToolUse response; unrelated actions return {}. */
export function evaluateHookInput(input) {
  if (!isRecord(input)) return decision('deny', 'invalid Claude Code hook payload; refusing to run the tool');
  if (input.hook_event_name !== EVENT) return {};

  const toolName = input.tool_name;
  const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
  if (toolName === 'Bash' && typeof toolInput.command === 'string') {
    if (asksForRecursiveDelete(toolInput.command)) {
      return decision('deny', 'recursive forced deletion is denied; do not run this command');
    }
    if (/\bgit\s+push\b/i.test(toolInput.command)) {
      return decision('ask', 'git push requires explicit human approval');
    }
  }
  if (FILE_TOOLS.has(toolName)) {
    const reason = guardedFileReason(toolInput.file_path);
    if (reason) return decision('ask', reason);
  }
  return {};
}

async function readStdin() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  let response;
  try {
    response = evaluateHookInput(JSON.parse(await readStdin()));
  } catch {
    response = decision('deny', 'invalid Claude Code hook JSON; refusing to run the tool');
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify(decision('deny', 'Claude Code hook failed; refusing to run the tool'))}\n`);
  });
}

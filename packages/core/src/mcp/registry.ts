import { z } from 'zod';

/**
 * MCP tool registry contract (plan §8.3). Each module contributes tools here;
 * the mcp module turns them into tools/list + tools/call. Names use underscores
 * (some clients reject dots). Every tool declares the scope(s) it requires and
 * the hints that drive tools/list filtering + MCP annotations.
 */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

export interface McpActor {
  type: 'user' | 'agent';
  id: string;
  organizationId: string;
  orgRole: string | null;
  projectRole: (projectId: string) => string | null;
  scopes: string[];
  projectIds: string[] | null;
  apiKeyId?: string;
}

export interface McpCallContext {
  actor: McpActor;
  requestId: string;
}

export interface McpToolDefinition<In = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  /** Scopes required; a key needs at least one to see or call the tool. */
  scopes: string[];
  annotations: ToolAnnotations;
  /** Optional module gate: only listed/callable when that module is enabled. */
  module?: string;
  handler: (args: In, ctx: McpCallContext) => Promise<unknown>;
}

export type AnyTool = McpToolDefinition<Record<string, unknown>>;

/** In-memory tool registry populated at module registration time. */
export class ToolRegistry {
  private tools = new Map<string, AnyTool>();

  register<T extends AnyTool>(tool: T): void {
    this.tools.set(tool.name, tool as AnyTool);
  }

  all(): AnyTool[] {
    return [...this.tools.values()];
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Tools an actor may see: matching scope AND (module enabled or module-less).
   * `isEnabled` is provided by the caller (async module-registry check).
   */
  async visible(
    scopes: string[],
    isEnabled: (module: string) => Promise<boolean>,
  ): Promise<AnyTool[]> {
    const out: AnyTool[] = [];
    for (const t of this.tools.values()) {
      if (!t.scopes.some((s) => scopes.includes(s))) continue;
      if (t.module && !(await isEnabled(t.module))) continue;
      out.push(t);
    }
    return out;
  }
}

/** Mask secrets in logged tool inputs (plan §8.8/§14). */
export function maskInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (/token|key|password|secret|authorization/i.test(k)) out[k] = '[MASKED]';
    else if (v && typeof v === 'object') out[k] = maskInput(v);
    else out[k] = v;
  }
  return out;
}

/** Cap tool output at 50 KiB (plan §8.9); oversized results truncated + flagged. */
export const MCP_MAX_OUTPUT_BYTES = 50 * 1024;
export function capOutput(payload: unknown): { payload: unknown; truncated: boolean } {
  const json = JSON.stringify(payload ?? null);
  if (Buffer.byteLength(json, 'utf8') <= MCP_MAX_OUTPUT_BYTES) return { payload, truncated: false };
  return { payload: { truncated: true, preview: json.slice(0, MCP_MAX_OUTPUT_BYTES) }, truncated: true };
}

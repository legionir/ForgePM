import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '@forgepm/shared';
import {
  type ToolRegistry,
  type ModuleRegistry,
  type Db,
  type McpCallContext,
  maskInput,
  capOutput,
  newId,
  defaultRegistry,
  toJsonb,
} from '@forgepm/core';
import { authenticate, type Actor } from '../../app/auth-context';
import { jsonSchemaFor } from './json-schema';

const rpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

const PROTOCOL_VERSION = '2024-11-05';

export interface McpDeps {
  db: Db;
  registry: ModuleRegistry;
  tools: ToolRegistry;
  rateLimitPerMinute: number;
}

/** Zod → JSON Schema for tools/list. See ./json-schema.ts: the advertisement has to
 *  match what `callTool` enforces below, or clients are taught to send what is refused. */
const jsonSchema = jsonSchemaFor;

const rateBuckets = new Map<string, { count: number; resetAt: number }>();
export function resetRateBuckets(): void {
  rateBuckets.clear();
}
function rateOk(keyId: string, limit: number): boolean {
  const now = Date.now();
  const hit = rateBuckets.get(keyId);
  if (!hit || hit.resetAt <= now) {
    rateBuckets.set(keyId, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  hit.count += 1;
  return hit.count <= limit;
}

export interface CallToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  structuredContent?: unknown;
}

/** Dispatch a tool call with the full runtime §3b-6 order + call logging. */
export async function callTool(
  deps: McpDeps,
  actor: Actor,
  name: string,
  args: Record<string, unknown>,
  requestId: string,
): Promise<CallToolResult> {
  const started = Date.now();
  const tool = deps.tools.get(name);
  if (!tool) return fail(deps, actor, name, args, 'NOT_FOUND', `tool '${name}' not found`, started, requestId);
  if (!tool.scopes.some((s) => (actor.scopes as string[]).includes(s))) {
    return fail(
      deps,
      actor,
      name,
      args,
      'FORBIDDEN_SCOPE',
      `FORBIDDEN_SCOPE: requires scope: ${tool.scopes.join(',')}`,
      started,
      requestId,
    );
  }
  const mods = tool.module ? (Array.isArray(tool.module) ? tool.module : [tool.module]) : [];
  if (mods.length) {
    let any = false;
    for (const m of mods)
      if (await deps.registry.isEnabled(deps.db, m, actor.organizationId, null)) {
        any = true;
        break;
      }
    if (!any) {
      return fail(
        deps,
        actor,
        name,
        args,
        'MODULE_DISABLED',
        `MODULE_DISABLED: module '${mods.join("' or '")}' is disabled`,
        started,
        requestId,
      );
    }
  }
  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) {
    return fail(
      deps,
      actor,
      name,
      args,
      'VALIDATION_ERROR',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      started,
      requestId,
    );
  }
  const ctx: McpCallContext = { actor: toMcpActor(actor), requestId };
  try {
    const out = await tool.handler(parsed.data as never, ctx);
    const capped = capOutput(out);
    const pending = isPending(capped.payload);
    await logCall(
      deps.db,
      actor,
      name,
      args,
      pending ? 'pending_approval' : 'ok',
      null,
      Date.now() - started,
      requestId,
    );
    return {
      content: [{ type: 'text', text: JSON.stringify(capped.payload) }],
      structuredContent: capped.payload,
      isError: false,
    };
  } catch (err) {
    if (err instanceof AppError)
      return fail(deps, actor, name, args, err.code, `${err.code}: ${err.message}`, started, requestId);
    return fail(deps, actor, name, args, 'INTERNAL', 'internal error', started, requestId);
  }
}

async function fail(
  deps: McpDeps,
  actor: Actor,
  name: string,
  args: Record<string, unknown>,
  code: string,
  text: string,
  started: number,
  requestId: string,
): Promise<CallToolResult> {
  await logCall(deps.db, actor, name, args, 'error', code, Date.now() - started, requestId);
  return { content: [{ type: 'text', text }], isError: true };
}

function isPending(p: unknown): boolean {
  return !!p && typeof p === 'object' && (p as { status?: string }).status === 'pending_approval';
}

function toMcpActor(a: Actor) {
  return {
    type: a.type,
    id: a.id,
    organizationId: a.organizationId,
    orgRole: a.orgRole,
    projectRole: a.projectRole,
    scopes: a.scopes,
    projectIds: a.projectIds,
    apiKeyId: a.apiKeyId,
  };
}

async function logCall(
  db: Db,
  actor: Actor,
  tool: string,
  input: Record<string, unknown>,
  outcome: 'ok' | 'error' | 'pending_approval',
  errorCode: string | null,
  duration: number,
  requestId: string,
): Promise<void> {
  try {
    await db
      .insertInto('mcp_tool_calls')
      .values({
        id: newId(),
        organization_id: actor.organizationId,
        api_key_id: actor.apiKeyId ?? null,
        tool,
        input_summary: toJsonb(maskInput(input)) as never,
        outcome,
        error_code: errorCode,
        duration_ms: duration,
        request_id: requestId,
      })
      .execute();
    defaultRegistry.inc('forgepm_mcp_tool_calls_total', { tool, outcome });
  } catch {
    /* logging must never break a call */
  }
}

/** Streamable-HTTP JSON-RPC handler for `POST /mcp`. */
export function makeMcpHandler(deps: McpDeps) {
  return async function handle(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    let actor: Actor;
    try {
      actor = await authenticate(deps.db, req);
    } catch (err) {
      if (err instanceof AppError) return void reply.status(err.httpStatus).send(err.toJSON(req.id));
      return void reply
        .status(401)
        .send({ error: { code: 'AUTH_REQUIRED', message: 'authentication required', request_id: req.id } });
    }
    if (!rateOk(actor.apiKeyId ?? actor.id, deps.rateLimitPerMinute)) {
      return void reply.status(429).send(rpcErr(req.body, 'RATE_LIMITED: too many calls'));
    }
    const parsed = rpcRequestSchema.safeParse(req.body);
    if (!parsed.success)
      return void reply
        .status(400)
        .send({ jsonrpc: '2.0', error: { code: -32600, message: 'invalid request' }, id: null });
    const rpc = parsed.data;

    if (rpc.method === 'initialize') {
      return void reply.send(
        rpcOk(rpc, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
          serverInfo: { name: 'forgepm-mcp', version: '1.0.0' },
        }),
      );
    }
    if (rpc.method === 'notifications/initialized') return void reply.status(202).send();
    if (rpc.method === 'tools/list') {
      const visible = await deps.tools.visible(actor.scopes, async (m) =>
        deps.registry.isEnabled(deps.db, m, actor.organizationId, null),
      );
      return void reply.send(
        rpcOk(rpc, {
          tools: visible.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: jsonSchema(t.inputSchema),
            annotations: t.annotations,
          })),
        }),
      );
    }
    if (rpc.method === 'tools/call') {
      const body = (rpc.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      if (!body.name) return void reply.send(rpcErr(rpc, 'VALIDATION_ERROR: tool name required'));
      const result = await callTool(deps, actor, body.name, body.arguments ?? {}, req.id);
      return void reply.send(rpcOk(rpc, result));
    }
    if (rpc.method === 'resources/list') return void reply.send(rpcOk(rpc, { resources: [] }));
    if (rpc.method === 'prompts/list') return void reply.send(rpcOk(rpc, { prompts: [] }));
    return void reply.send({
      jsonrpc: '2.0',
      id: rpc.id ?? null,
      error: { code: -32601, message: `method ${rpc.method} not found` },
    });
  };
}

function rpcOk(rpc: z.infer<typeof rpcRequestSchema>, result: unknown) {
  return { jsonrpc: '2.0', id: rpc.id ?? null, result };
}
function rpcErr(rpc: unknown, message: string) {
  return { jsonrpc: '2.0', id: (rpc as { id?: string | number })?.id ?? null, error: { code: -32000, message } };
}

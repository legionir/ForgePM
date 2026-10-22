import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { jsonSchemaFor } from '../../src/modules/mcp/json-schema';
import { buildToolRegistry } from '../../src/modules/mcp/tools';
import { statusToolSchema } from '../../src/modules/exec/service';
import { projectRefSchema } from '../../src/modules/exec/context';
import { taskStartInputSchema, openItemInputSchema, evidenceInputSchema } from '@forgepm/shared';

/**
 * `tools/list` is a contract, not a courtesy: an agent that is told
 * `additionalProperties: true` will send extra keys and then be refused (B.1). The
 * advertisement must therefore say what the handler enforces — and must stay silent
 * (permissive) rather than wrong when a shape is not understood.
 */

type Schema = Record<string, unknown>;

describe('jsonSchemaFor', () => {
  it('marks a strictObject as closed and lists the required keys', () => {
    const out = jsonSchemaFor(
      z.strictObject({
        title: z.string().min(5).max(500),
        note: z.string().optional(),
        count: z.number().int().min(1).default(3),
      }),
    ) as Schema;
    expect(out.type).toBe('object');
    expect(out.additionalProperties).toBe(false);
    expect(out.required).toEqual(['title']);
    const props = out.properties as Record<string, Schema>;
    expect(props.title).toMatchObject({ type: 'string', minLength: 5, maxLength: 500 });
    expect(props.count).toMatchObject({ type: 'integer', minimum: 1, default: 3 });
  });

  it('does not claim strictness for a plain object', () => {
    const out = jsonSchemaFor(z.object({ a: z.string() })) as Schema;
    expect(out.additionalProperties).toBeUndefined();
  });

  it('maps arrays, enums, uuids and unions', () => {
    const out = jsonSchemaFor(
      z.strictObject({
        paths: z.array(z.string().min(1)).min(1).max(3),
        type: z.enum(['question', 'commitment']),
        id: z.string().uuid(),
        either: z.union([z.string(), z.boolean()]),
      }),
    ) as Schema;
    const props = out.properties as Record<string, Schema>;
    expect(props.paths).toMatchObject({ type: 'array', minItems: 1, maxItems: 3 });
    expect((props.paths?.items as Schema).type).toBe('string');
    expect(props.type).toMatchObject({ enum: ['question', 'commitment'] });
    expect(props.id).toMatchObject({ type: 'string', format: 'uuid' });
    expect(Array.isArray(props.either?.anyOf)).toBe(true);
  });

  it('keeps the ledger code pattern visible to clients', () => {
    const out = jsonSchemaFor(statusToolSchema) as Schema;
    const props = out.properties as Record<string, Schema>;
    expect(props.task_ref?.type).toBe('string');
    expect(out.required).toEqual([]);
  });

  it('falls back to a permissive shape for an unknown schema kind instead of guessing', () => {
    expect(jsonSchemaFor(z.number())).toEqual({ type: 'object' });
  });

  it('unwraps a preprocess: the wrapper changes the input, not the shape', () => {
    // The exit report accepts `task_id` as an alias for `task_ref` (the plan
    // and the repo spell it differently). The advertisement must still be the
    // strict object — a wrapper that renames one key does not make the tool
    // any more permissive than it is.
    const out = jsonSchemaFor(
      z.preprocess((v) => v, z.strictObject({ task_ref: z.string().min(3), note: z.string().optional() })),
    ) as Schema;
    expect(out.type).toBe('object');
    expect(out.additionalProperties).toBe(false);
    expect(out.required).toEqual(['task_ref']);
  });
});

describe('the ledger tools advertise what they enforce (B.1, §8)', () => {
  const names = [
    'exec_task_start',
    'ledger_add_open_item',
    'ledger_resolve_item',
    'ledger_list_open',
    'exec_ledger_status',
    'exec_ledger_reconcile',
    'session_start',
    'journal_start',
    'journal_done',
    'journal_fail',
    'exec_submit_exit_report',
    'exec_task_complete',
    'ledger_add_evidence',
    'ledger_record_decision',
    'ledger_ask_human',
    'exec_policy_check',
  ];
  const registry = { current: undefined as ReturnType<typeof buildToolRegistry> | undefined };
  it.each(names)('%s advertises additionalProperties:false and non-empty required', (name) => {
    // buildToolRegistry needs a Db only for handlers, which are never invoked here.
    registry.current ??= buildToolRegistry(undefined as never);
    const tool = registry.current?.get(name);
    expect(tool, name).toBeDefined();
    const advertised = jsonSchemaFor(tool!.inputSchema) as Schema;
    expect(advertised.additionalProperties, name).toBe(false);
    expect(Object.keys(advertised.properties as Record<string, unknown>).length, name).toBeGreaterThan(0);
  });

  it('every advertised property type is one JSON Schema understands', () => {
    registry.current ??= buildToolRegistry(undefined as never);
    for (const tool of registry.current!.all()) {
      const advertised = jsonSchemaFor(tool.inputSchema) as Schema;
      const props = (advertised.properties ?? {}) as Record<string, Schema>;
      for (const [key, value] of Object.entries(props)) {
        const type = value.type;
        if (type === undefined) continue; // anyOf-only unions
        expect(['string', 'number', 'integer', 'boolean', 'array', 'object'], `${tool.name}.${key}`).toContain(type);
      }
    }
  });
});

type Prop = { type?: string; description?: string; anyOf?: unknown[] };
const props = (schema: z.ZodTypeAny): Record<string, Prop> => (jsonSchemaFor(schema).properties ?? {}) as Record<string, Prop>;

describe('tools/list parameter descriptions', () => {
  it('parameter descriptions: a describe() text becomes the property description, also through optional, default and nullable', () => {
    const p = props(
      z.object({
        a: z.string().describe('plain text'),
        b: z.string().describe('optional text').optional(),
        c: z.number().int().default(5).describe('defaulted text'),
        d: z.string().describe('nullable text').nullable(),
        e: z.string(),
      }),
    );
    expect(p.a.description).toBe('plain text');
    expect(p.b.description).toBe('optional text');
    expect(p.c.description).toBe('defaulted text');
    expect(p.d.description).toBe('nullable text');
    expect(p.e.description).toBe('a string'); // undescribed fields keep the old generic text
  });

  it('project_ref and task_ref have real descriptions that say where to get a value', () => {
    const start = props(taskStartInputSchema);
    expect(start.project_ref.description).toMatch(/ledger_projects/);
    expect(start.project_ref.description).toMatch(/key/i);
    expect(start.title.description).toMatch(/name of the task/i);
    expect(start.acceptance_criteria.description).toMatch(/test:NAME/);

    const item = props(openItemInputSchema);
    expect(item.task_ref.description).toMatch(/T-004/);
    expect(item.task_ref.description).toMatch(/exec_task_start/);

    expect(jsonSchemaFor(z.object({ project_ref: projectRefSchema.optional() })).properties).toMatchObject({
      project_ref: { description: expect.stringContaining('ledger_projects') },
    });
  });

  it('criterion_ref carries its own description in the evidence tool', () => {
    expect(props(evidenceInputSchema).criterion_ref?.description ?? '').toMatch(/C-12|criterion/i);
  });
});

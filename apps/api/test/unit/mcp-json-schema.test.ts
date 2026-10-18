import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { jsonSchemaFor } from '../../src/modules/mcp/json-schema';
import { buildToolRegistry } from '../../src/modules/mcp/tools';
import { statusToolSchema } from '../../src/modules/exec/service';

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
});

describe('the five ledger tools advertise what they enforce (B.1)', () => {
  const names = [
    'exec_task_start',
    'ledger_add_open_item',
    'ledger_resolve_item',
    'ledger_list_open',
    'exec_ledger_status',
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

import { z } from 'zod';

/**
 * zod → JSON Schema for `tools/list` (plan §8.3).
 *
 * The first version of this mapper printed `{type:'object'}` for everything and
 * `additionalProperties: true` regardless of the real schema — which was a lie for
 * every strict tool: the handler refuses unknown keys (B.1) while the advertisement
 * invited them, so a client that trusted `tools/list` built calls the server would
 * reject. Advertising the actual shape is what lets an agent get it right the first
 * time instead of learning by error.
 *
 * Deliberately small: it covers what the ledger schemas use and falls back to the
 * old permissive `{type:'string'}` for anything exotic, so an unmapped type is
 * under-specified rather than wrong.
 */

type Json = Record<string, unknown>;

const typeName = (schema: z.ZodTypeAny): string =>
  (schema as unknown as { _def?: { typeName?: string } })._def?.typeName ?? '';

/** A `strictObject` marks `unknownKeys === 'strict'`; a plain object does not lie about it. */
function isStrict(schema: z.ZodTypeAny): boolean {
  return (schema as unknown as { _def?: { unknownKeys?: string } })._def?.unknownKeys === 'strict';
}

/** The shape of one schema plus the text of its `.describe()` when it has one. */
function describe(schema: z.ZodTypeAny, depth = 0): Json {
  const out = describeShape(schema, depth);
  const text = (schema as unknown as { _def?: { description?: string } })._def?.description;
  if (text) out.description = text;
  return out;
}

function describeShape(schema: z.ZodTypeAny, depth: number): Json {
  const inner = (schema as unknown as { _def?: { innerType?: z.ZodTypeAny; type?: z.ZodTypeAny; schema?: z.ZodTypeAny } })._def;
  const name = typeName(schema);
  // A `preprocess`/`transform` wrapper does not change the shape it wraps — it
  // only changes what happens before it. Advertising the inner shape is the
  // truth; advertising `{type:'object'}` would be a lie.
  if (name === 'ZodEffects' && inner?.schema) return describe(inner.schema, depth);
  if (name === 'ZodOptional' && inner?.innerType) return describe(inner.innerType, depth);
  if (name === 'ZodNullable' && inner?.innerType) {
    return { anyOf: [describe(inner.innerType, depth), { type: 'null' }] };
  }
  if (name === 'ZodDefault' && inner?.innerType) {
    const base = describe(inner.innerType, depth);
    const def = (schema as unknown as { _def?: { defaultValue?: () => unknown } })._def?.defaultValue;
    if (def) base.default = def();
    return base;
  }
  if (name === 'ZodObject') {
    if (depth >= 3) return { type: 'object' };
    return objectSchema(schema as z.ZodObject<z.ZodRawShape>, depth);
  }
  if (name === 'ZodArray') {
    const out: Json = { type: 'array', items: describe((schema as z.ZodArray<z.ZodTypeAny>).element, depth + 1) };
    const limits = (schema as unknown as { _def: { minLength?: { value: number }; maxLength?: { value: number } } })
      ._def;
    if (limits.minLength) out.minItems = limits.minLength.value;
    if (limits.maxLength) out.maxItems = limits.maxLength.value;
    return out;
  }
  if (name === 'ZodString') {
    const checks = (schema as unknown as { _def: { checks?: { kind: string; value?: number; regex?: RegExp }[] } })._def
      .checks;
    const out: Json = { type: 'string', description: describeString(checks) };
    for (const c of checks ?? []) {
      if (c.kind === 'min' && c.value) out.minLength = c.value;
      if (c.kind === 'max' && c.value) out.maxLength = c.value;
      if (c.kind === 'uuid') out.format = 'uuid';
      if (c.kind === 'regex' && c.regex) out.pattern = c.regex.source;
    }
    return out;
  }
  if (name === 'ZodNumber') {
    const checks = (schema as unknown as { _def: { checks?: { kind: string; value?: number }[] } })._def.checks;
    const out: Json = { type: 'number' };
    for (const c of checks ?? []) {
      if (c.kind === 'int') out.type = 'integer';
      if (c.kind === 'min') out.minimum = c.value;
      if (c.kind === 'max') out.maximum = c.value;
    }
    return out;
  }
  if (name === 'ZodBoolean') return { type: 'boolean' };
  if (name === 'ZodEnum') return { type: 'string', enum: (schema as z.ZodEnum<[string, ...string[]]>).options };
  if (name === 'ZodLiteral') {
    const literal = (schema as unknown as { value: unknown }).value;
    return { type: typeof literal, const: literal };
  }
  if (name === 'ZodUnion') {
    const options = (schema as unknown as { _def: { options: z.ZodTypeAny[] } })._def.options;
    return { anyOf: options.map((o) => describe(o, depth)) };
  }
  return { type: 'string' };
}

function describeString(checks?: { kind: string; regex?: RegExp }[]): string {
  if (checks?.some((c) => c.kind === 'uuid')) return 'a uuid';
  return 'a string';
}

function objectSchema(schema: z.ZodObject<z.ZodRawShape>, depth: number): Json {
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  const properties: Record<string, Json> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    // `optional` and `default` both mean "the caller may omit it"; the old code only
    // looked for ZodOptional, so defaulted fields were advertised as required.
    const name = typeName(value);
    const omitted = name === 'ZodOptional' || name === 'ZodDefault' || name === 'ZodUndefined';
    if (!omitted) required.push(key);
    properties[key] = describe(value, depth + 1);
  }
  const out: Json = { type: 'object', properties, required };
  if (isStrict(schema as unknown as z.ZodTypeAny)) out.additionalProperties = false;
  return out;
}

/** Public entry point: the JSON Schema `tools/list` advertises for one tool. */
export function jsonSchemaFor(schema: z.ZodTypeAny): Json {
  const base = describe(schema, 0);
  if (base.type !== 'object') return { type: 'object' };
  return base;
}

/**
 * pg only auto-serialises objects/arrays for jsonb params; scalars
 * (string/number/boolean) must be JSON.stringify-ed first, or Postgres
 * rejects them with "invalid input syntax for type json".
 */
export function toJsonb(value: unknown): string {
  return JSON.stringify(value ?? null);
}

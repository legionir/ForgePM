import { z } from 'zod';

/**
 * Bootstrap environment (plan §3b-1: env is only for bootstrap).
 * Validated once at process start; invalid env => clear message + exit(1).
 * Secrets that live in the DB (provider keys, GitHub App key) are NOT here;
 * these env vars are only copied into the `secrets` table on first use.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string(),

  // 32-byte base64 AES key for `secrets`/provider-key encryption (§14).
  FORGEPM_SECRET_KEY: z
    .string()
    .min(1)
    .refine(
      (v) => {
        try {
          return Buffer.from(v, 'base64').length === 32;
        } catch {
          return false;
        }
      },
      { message: 'FORGEPM_SECRET_KEY must be 32 bytes, base64-encoded' },
    ),

  WEB_ORIGIN: z.string().url().default('http://localhost:4200'),
  API_DOCS_ENABLED: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
  METRICS_ENABLED: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true'),

  // First-run bootstrap admin (plan §5.2). Optional; setup screen is the fallback.
  // Empty string counts as unset (docker-compose `${VAR:-}` passes "").
  FORGEPM_ADMIN_EMAIL: z.preprocess((v) => (v === '' ? undefined : v), z.string().email().optional()),
  FORGEPM_ADMIN_PASSWORD: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(8).optional()),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

/** Throws with a formatted, actionable message on invalid env (testable). */
export function parseEnv(raw: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

/** Process entrypoint helper: parse process.env, print + exit(1) on failure. */
export function loadEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  try {
    return parseEnv(raw);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }
}

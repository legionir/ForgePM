import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import openapiTS, { astToString } from 'openapi-typescript';
import { createDb, loadEnv } from '@forgepm/core';
import { buildApp } from '../apps/api/src/app/app';
import { buildRegistry } from '../apps/api/src/app/modules';

/**
 * pnpm gen:api — regenerate the OpenAPI spec + typed client from the live app
 * (plan §11: "the API client is generated from the OpenAPI spec"). Deterministic
 * because route order equals registration order.
 *
 *   pnpm gen:api           write apps/api/openapi.json + apps/web/src/api/schema.d.ts
 *   pnpm gen:api --check   exit 1 if the committed files differ from generated
 *
 * Needs a reachable Postgres (DATABASE_URL); the app is built in-process, never
 * listened on. Secrets are irrelevant to route/schema collection.
 */
const ROOT = join(dirname(new URL(import.meta.url).pathname), '..');
const SPEC_OUT = join(ROOT, 'apps', 'api', 'openapi.json');
const CLIENT_OUT = join(ROOT, 'apps', 'web', 'src', 'api', 'schema.d.ts');
const CHECK = process.argv.includes('--check');

async function generate(): Promise<{ spec: string; client: string }> {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);
  const app = await buildApp({
    env,
    db,
    registry: buildRegistry(),
    redisAvailable: () => Promise.resolve(false),
  });
  await app.ready();
  const res = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
  await app.close();
  await db.destroy();
  if (res.statusCode !== 200) throw new Error(`openapi route returned ${res.statusCode}`);
  const doc = res.json();
  const spec = JSON.stringify(doc, null, 2) + '\n';
  // openapiTS accepts the parsed JSON object (OpenAPI3) and returns a TS AST;
  // astToString renders it to the committed .d.ts text.
  const ast = await openapiTS(doc as never, { version: 3 });
  const client = astToString(ast);
  return { spec, client };
}

async function main(): Promise<void> {
  const { spec, client } = await generate();
  if (CHECK) {
    for (const [path, content] of [[SPEC_OUT, spec], [CLIENT_OUT, client]] as const) {
      const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
      if (current !== content) {
        process.stderr.write(`gen:api drift: ${path} is out of date — run 'pnpm gen:api'\n`);
        process.exit(1);
      }
    }
    process.stdout.write('gen:api: committed spec + client are up to date\n');
    return;
  }
  mkdirSync(dirname(CLIENT_OUT), { recursive: true });
  writeFileSync(SPEC_OUT, spec);
  writeFileSync(CLIENT_OUT, client);
  const paths = Object.keys(JSON.parse(spec).paths).length;
  process.stdout.write(`gen:api: wrote openapi.json (${paths} paths) + schema.d.ts\n`);
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});

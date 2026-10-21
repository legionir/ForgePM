// One command for the whole stack: `npm start` (alias `npm run dev`).
// Builds the shared packages (apps resolve them through dist/), then runs the
// API, the worker and the Angular panel side by side with prefixed output.
// Without Redis the worker degrades to its DB-only jobs; nothing here needs Docker.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createConnection } from 'node:net';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
process.chdir(root);

if (!existsSync('.env')) {
  copyFileSync('.env.example', '.env');
  appendFileSync('.env', `\nFORGEPM_SECRET_KEY=${randomBytes(32).toString('base64')}\n`);
  console.log('[dev] created .env from .env.example with a fresh FORGEPM_SECRET_KEY');
}
process.loadEnvFile('.env');
process.env.REDIS_URL ||= 'redis://localhost:6379';

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: 'inherit', shell: true, ...opts }).status === 0;
}

function reachable(url) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const s = createConnection({ host: hostname, port: Number(port) || 5432 });
    s.setTimeout(2000);
    s.on('connect', () => (s.destroy(), resolve(true)));
    s.on('error', () => resolve(false));
    s.on('timeout', () => (s.destroy(), resolve(false)));
  });
}

if (!(await reachable(process.env.DATABASE_URL))) {
  console.error(`[dev] PostgreSQL is not reachable at DATABASE_URL (${process.env.DATABASE_URL.replace(/:[^:@/]*@/, ':***@')}). Start it, then retry.`);
  process.exit(1);
}
if (!(await reachable(process.env.REDIS_URL))) {
  console.warn('[dev] Redis not reachable: the worker runs in degraded mode (no queue/dispatcher).');
}

console.log('[dev] building shared packages…');
if (!run('npm', ['run', 'build', '--workspace', '@forgepm/shared', '--workspace', '@forgepm/core'])) process.exit(1);

const services = [
  ['api', 'npx', ['tsx', 'watch', 'apps/api/src/main.ts'], root],
  ['worker', 'npx', ['tsx', 'watch', 'apps/worker/src/main.ts'], root],
  ['web', 'npx', ['ng', 'serve', '--port', '4200', '--proxy-config', 'proxy.conf.json'], `${root}/apps/web`, { PORT: '4200' }],
];

const children = services.map(([name, cmd, args, cwd, extraEnv]) => {
  const child = spawn(cmd, args, { cwd, shell: true, env: { ...process.env, ...extraEnv } });
  const pipe = (stream, out) =>
    stream.on('data', (d) =>
      String(d).split(/\r?\n/).filter(Boolean).forEach((l) => out.write(`[${name}] ${l}\n`)));
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => console.log(`[dev] ${name} exited (${code})`));
  return child;
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F']);
    else c.kill('SIGTERM');
  }
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

setTimeout(() => {
  console.log(`\n[dev] panel: http://localhost:4200   api: http://localhost:${process.env.PORT || 3001}/health/ready`);
  console.log(`[dev] admin: ${process.env.FORGEPM_ADMIN_EMAIL || '(use the setup screen)'}\n`);
}, 1000);

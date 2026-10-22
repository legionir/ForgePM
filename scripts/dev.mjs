#!/usr/bin/env node
// One command for the whole stack. `forgepm` (bin) runs the BUILT output: api + worker from dist/ and the
// panel's static build served on :4200 with the API proxied (no build, no watchers). `--build` builds first.
// `npm start` / `npm run dev` pass `--dev` for watch mode (tsx watch + ng serve).
// Without Redis the worker degrades to its DB-only jobs; nothing here needs Docker.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, createReadStream, existsSync, statSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';
import { createServer, request as httpRequest } from 'node:http';
import { extname, join, normalize } from 'node:path';

const devMode = process.argv.includes('--dev');
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

const WEB_DIR = join(root, 'apps/web/dist/web/browser');
const BUILT = ['apps/api/dist/main.js', 'apps/worker/dist/main.js', 'apps/web/dist/web/browser/index.html'];

if (devMode) {
  console.log('[dev] building shared packages…');
  if (!run('npm', ['run', 'build', '--workspace', '@forgepm/shared', '--workspace', '@forgepm/core'])) process.exit(1);
} else {
  if (process.argv.includes('--build')) {
    console.log('[forgepm] building all workspaces…');
    if (!run('npm', ['run', 'build']) || !run('npm', ['run', 'build', '--prefix', 'apps/web'])) process.exit(1);
  }
  const missing = BUILT.filter((f) => !existsSync(f));
  if (missing.length) {
    console.error(`[forgepm] no build found (${missing.join(', ')}). Run "npm run build" once, or "forgepm --build".`);
    process.exit(1);
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain',
};
const apiPort = Number(process.env.PORT) || 3001;

/** Serves the panel build with an SPA fallback and proxies /api/, /health/ and /mcp to the API (same rules as nginx.conf). */
function startStaticPanel(port) {
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (/^\/(api\/|health\/|mcp(\?|$))/.test(url)) {
      const up = httpRequest({ host: '127.0.0.1', port: apiPort, path: url, method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => (res.writeHead(502), res.end('api unreachable')));
      req.pipe(up);
      return;
    }
    const clean = normalize(decodeURIComponent(url.split('?')[0])).replace(/^([/\\]\.\.)+/, '');
    let file = join(WEB_DIR, clean);
    if (!file.startsWith(WEB_DIR) || !existsSync(file) || statSync(file).isDirectory()) file = join(WEB_DIR, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  server.listen(port, () => console.log(`[web] serving built panel on http://localhost:${port}`));
  return server;
}

const services = devMode
  ? [
      ['api', 'npx', ['tsx', 'watch', 'apps/api/src/main.ts'], root],
      ['worker', 'npx', ['tsx', 'watch', 'apps/worker/src/main.ts'], root],
      ['web', 'npx', ['ng', 'serve', '--port', '4200', '--proxy-config', 'proxy.conf.json'], `${root}/apps/web`, { PORT: '4200' }],
    ]
  : [
      ['api', 'node', ['apps/api/dist/main.js'], root],
      ['worker', 'node', ['apps/worker/dist/main.js'], root],
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

const panel = devMode ? null : startStaticPanel(Number(process.env.FORGEPM_PANEL_PORT) || 4200);

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  panel?.close();
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

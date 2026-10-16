import { defineConfig, devices } from '@playwright/test';

/**
 * Plan §15/§11 E2E gate for the panel. Base URL is the Angular dev-server,
 * which proxies /api to the backend on :3001 (see proxy.conf.json).
 * `webServer` starts both backend (via npm run dev:api against a fresh DB) and
 * the dev-server; local E2E scripts pre-seed DATABASE_URL to a throwaway DB.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  // single honest shot: the flake was the apikey step racing a slow runner,
  // now fixed by awaiting the real POST response. e2e.sh resets the DB once,
  // so a retry would run against dirty (already-set-up) state — disabled.
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.PANEL_URL ?? 'http://localhost:4200',
    trace: 'off',
    // sandbox/local runs can inject a stock chromium binary (@sparticuz/
    // chromium extraction) instead of the playwright-managed download.
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: process.env.CHROMIUM_ARGS ? process.env.CHROMIUM_ARGS.split(' ') : undefined,
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

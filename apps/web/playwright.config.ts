import { defineConfig, devices } from '@playwright/test';

/**
 * Plan §15/§11 E2E gate for the panel. Base URL is the Angular dev-server,
 * which proxies /api to the backend on :3001 (see proxy.conf.json).
 * `webServer` starts both backend (via pnpm dev:api against a fresh DB) and
 * the dev-server; local E2E scripts pre-seed DATABASE_URL to a throwaway DB.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [['list']],
  use: { baseURL: process.env.PANEL_URL ?? 'http://localhost:4200', trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

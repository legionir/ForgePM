import { test, expect } from '@playwright/test';

/**
 * Flagship E2E (plan §11 acceptance, subset): first-run setup → create project
 * → create API key (raw shown once) → sign out → sign back in. Runs against
 * the real Fastify API behind the Angular dev-server proxy (Postgres + Redis
 * on localhost, plan §15 rule "no external services").
 *
 * Setup and login are separate routes/components, so no form is re-rendered
 * under a fill. The API-key step additionally awaits its real POST response.
 */
const EMAIL = 'admin@e2e.test';
const PASSWORD = 'e2e-password-1';

test('setup → project → api key → logout → login', async ({ page }) => {
  await page.goto('/setup');
  await expect(page.getByTestId('setup-submit')).toBeVisible();

  // 1) first-run setup form (e2e.sh resets the DB per run)
  await page.getByTestId('field-org').fill('E2E Org');
  await page.getByTestId('field-dname').fill('E2E Admin');
  await page.getByTestId('field-email').fill(EMAIL);
  await page.getByTestId('field-password').fill(PASSWORD);
  await page.getByTestId('setup-submit').click();

  // 2) land on Projects, create one
  await expect(page.getByTestId('projects')).toBeVisible();
  await page.getByTestId('project-key').fill('EPRJ');
  await page.getByTestId('project-name').fill('E2E Project');
  await page.getByTestId('project-create').click();
  await expect(page.getByText('EPRJ · E2E Project')).toBeVisible();

  // 3) API keys: create → raw visible exactly once, then only prefix remains
  await page.getByTestId('nav-api-keys').click();
  await expect(page.getByTestId('api-keys')).toBeVisible();
  await page.getByTestId('apikey-name').fill('ci');
  const resp = page
    .waitForResponse((r) => r.request().method() === 'POST' && /\/api\/v1\/api-keys$/.test(r.url()), { timeout: 30_000 })
    .catch(() => null);
  await page.getByTestId('apikey-create').click();
  const created = await resp;
  if (created && !created.ok()) {
    throw new Error(`api-key create failed ${created.status()}: ${await created.text()}`);
  }
  const raw = page.getByTestId('apikey-raw');
  await expect(raw).toBeVisible();
  await expect(raw).toContainText('fpm_');

  // 4) sign out → login route, sign back in with the same credentials
  await page.getByTestId('logout').click();
  await expect(page.getByTestId('login-submit')).toBeVisible();
  await page.getByTestId('field-email').fill(EMAIL);
  await page.getByTestId('field-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('projects')).toBeVisible();

  // 5) the raw key must never appear again after reload of the list
  await page.getByTestId('nav-api-keys').click();
  await expect(page.getByTestId('api-keys')).toBeVisible();
  await expect(page.getByTestId('apikey-raw')).toHaveCount(0);
});

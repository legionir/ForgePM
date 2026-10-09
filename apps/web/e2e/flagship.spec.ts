import { test, expect } from '@playwright/test';

/**
 * Flagship E2E (plan §11 acceptance, subset): first-run setup → create project
 * → create API key (raw shown once) → sign out → sign back in. Runs against
 * the real Fastify API behind the Angular dev-server proxy (Postgres + Redis
 * on localhost, plan §15 rule "no external services").
 */
const EMAIL = 'admin@e2e.test';
const PASSWORD = 'e2e-password-1';

// Slower CI runners need headroom for the Angular dev-server first paint.
test.use({ actionTimeout: 15_000 });

test('setup → project → api key → logout → login', async ({ page }) => {
  await page.goto('/auth');

  // 1) first-run setup form is present (fresh DB)
  await expect(page.getByTestId('setup-submit')).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('Organization').fill('E2E Org');
  await page.getByLabel('Admin name').fill('E2E Admin');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByTestId('setup-submit').click();

  // 2) land on Projects, create one
  await expect(page.getByTestId('projects')).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('Key').fill('EPRJ');
  await page.getByLabel('Name').fill('E2E Project');
  await page.getByTestId('project-create').click();
  await expect(page.getByText('EPRJ · E2E Project')).toBeVisible({ timeout: 20_000 });

  // 3) API keys: create → raw visible exactly once, then only prefix remains
  await page.getByTestId('nav-api-keys').click();
  await expect(page.getByTestId('api-keys')).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('Name').fill('ci');
  await page.getByTestId('apikey-create').click();
  const raw = page.getByTestId('apikey-raw');
  await expect(raw).toBeVisible({ timeout: 20_000 });
  await expect(raw).toContainText('fpm_');

  // 4) sign out, then sign back in with the same credentials
  await page.getByTestId('logout').click();
  await expect(page.getByTestId('auth')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('go-login').click();
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('projects')).toBeVisible({ timeout: 20_000 });

  // 5) the raw key must never appear again after reload of the list
  await page.getByTestId('nav-api-keys').click();
  await expect(page.getByTestId('api-keys')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('apikey-raw')).toHaveCount(0);
});

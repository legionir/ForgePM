import { test, expect } from '@playwright/test';

/**
 * P-05 (PERFORMANCE_BUDGET.md, plan §11): the work-item list page of the
 * 200,000-item project paints in under 2s (fail band 2.4s) in the reference
 * environment — measured here as first contentful paint after the list rows
 * commit, in a Chromium run against the seeded `forgepm_perf` dataset
 * (`bash apps/web/e2e-perf.sh`). The list is cursor-paginated (§1.4), so the
 * page renders one bounded page, not 200k DOM nodes; that is precisely the
 * budget being asserted.
 *
 * Env: PERF_PANEL_EMAIL (perf@seed.local), PERF_PANEL_PASSWORD, PERF_PROJECT_ID.
 */
const EMAIL = process.env.PERF_PANEL_EMAIL ?? 'perf@seed.local';
const PASSWORD = process.env.PERF_PANEL_PASSWORD ?? 'perf-password-1';
const PROJECT_ID = process.env.PERF_PROJECT_ID ?? '';

test('P-05 first paint of the 200k-project item list < 2000ms', async ({ page }) => {
  test.setTimeout(120_000);
  expect(PROJECT_ID, 'PERF_PROJECT_ID is required (see apps/web/e2e-perf.sh)').toMatch(/[0-9a-f-]{36}/);

  await page.goto('/login');
  await page.getByTestId('field-email').fill(EMAIL);
  await page.getByTestId('field-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('projects')).toBeVisible();

  const t0 = Date.now();
  await page.goto(`/work-items?project=${PROJECT_ID}`);
  await expect(page.getByTestId('wi-list').getByTestId('wi-link').first()).toBeVisible();
  const paint = Date.now() - t0;
  console.log(`P-05 first paint: ${paint}ms (threshold 2000, fail 2400)`);
  expect(paint).toBeLessThan(2000);
});

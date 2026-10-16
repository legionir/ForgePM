import { expect, type Page } from '@playwright/test';

/**
 * Shared E2E helpers (§11). Kept OUT of any *.spec.ts so importing them does
 * not re-register another spec's tests (visual.spec used to import
 * chain.spec and drag the whole chain into its run).
 */
export const EMAIL = 'admin@e2e.test';
export const PASSWORD = 'e2e-password-1';

export async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('field-email').fill(EMAIL);
  await page.getByTestId('field-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('projects')).toBeVisible();
}

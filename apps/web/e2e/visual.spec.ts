import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { login } from './helpers';

/**
 * Visual regression (plan §10 P7-2, ENF-003): screenshot baselines for the
 * shell + key pages, in both themes. OPT-IN because baselines are
 * environment-sensitive (fonts/GPU): run `VISUAL=1 bash apps/web/e2e.sh`
 * once locally to write baselines (`npx playwright test visual.spec.ts
 * --update-snapshots`), commit them, and CI then enforces diffs.
 * Animations are disabled for determinism.
 */

test.use({ viewport: { width: 1280, height: 800 } });

/**
 * First-run setup via the API (idempotent: CONFLICT on an already-set-up
 * install is ignored) so `login()` below works on a brand-new database —
 * the same setup-first policy the chain spec follows interactively.
 */
test.beforeAll(async ({ request }) => {
  await request.post('/api/v1/auth/setup', {
    data: { organization_name: 'E2E Org', admin_display_name: 'E2E Admin', admin_email: 'admin@e2e.test', admin_password: 'e2e-password-1' },
  }).catch(() => undefined);
});

const PAGES: [string, string][] = [
  ['/projects', 'projects'],
  ['/work-items', 'work-items'],
  ['/approvals', 'approvals'],
  ['/system', 'system'],
  ['/design-system', 'design-system'],
];

for (const dark of [false, true]) {
  const suffix = dark ? '-dark' : '-light';

  test.describe(`visual${suffix}`, () => {
    test.skip(!process.env.VISUAL, 'opt-in: run with VISUAL=1 after committing baselines');

    test.beforeEach(async ({ page }) => {
      await login(page);
      // Deterministic rendering: fixed theme, no animations.
      await page.evaluate((d) => {
        document.cookie = `forgepm_theme=${d ? 'dark' : 'light'}; path=/`;
        const style = document.createElement('style');
        style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
        document.documentElement.appendChild(style);
      }, dark);
      await page.reload();
      await expect(page.getByTestId('nav')).toBeVisible();
    });

    for (const [path, name] of PAGES) {
      test(`${name}${suffix} matches baseline`, async ({ page }) => {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        await expect(page.getByRole('main')).toHaveScreenshot(`${name}${suffix}.png`, {
          animations: 'disabled',
          maxDiffPixelRatio: 0.02,
        });
      });
    }

    test(`login${suffix} matches baseline`, async ({ page }) => {
      await page.context().clearCookies();
      await page.goto('/login');
      await page.waitForLoadState('networkidle');
      await expect(page.getByTestId('auth')).toHaveScreenshot(`login${suffix}.png`, {
        animations: 'disabled',
        maxDiffPixelRatio: 0.02,
      });
    });

    test(`a11y${suffix}: no critical axe violations on design-system`, async ({ page }) => {
      await page.goto('/design-system');
      const results = await new AxeBuilder({ page }).analyze();
      const critical = results.violations.filter((v) => v.impact === 'critical');
      expect(critical).toEqual([]);
    });
  });
}

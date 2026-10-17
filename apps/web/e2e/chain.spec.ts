import { test, expect } from '@playwright/test';
import { login } from './helpers';
import AxeBuilder from '@axe-core/playwright';

/**
 * Plan §11 flagship acceptance — the full chain in one browser session against
 * the real Fastify API + Angular dev-server (Postgres + Redis on localhost;
 * the only stand-in is the deterministic `fake` AI provider the plan itself
 * mandates for offline tests):
 *   setup → project → feature + items → board drag → plan (fake provider;
 *   approve and apply are separate clicks) → API key → MCP tool call → tool
 *   call log → GitHub config + enable + linked repo → Code Review with the
 *   fake provider producing a completed run.
 * The second case is the §11 a11y/locale gate: fa/RTL toggle + axe with no
 * serious/critical violations on the major pages.
 */
const EMAIL = 'admin@e2e.test';
const PASSWORD = 'e2e-password-1';



test('§11 full chain: setup → project → items → board → plan → key → mcp → github → review', async ({ page }) => {
  test.setTimeout(180_000);

  // 1) first-run setup
  await page.goto('/setup');
  await page.getByTestId('field-org').fill('E2E Org');
  await page.getByTestId('field-dname').fill('E2E Admin');
  await page.getByTestId('field-email').fill(EMAIL);
  await page.getByTestId('field-password').fill(PASSWORD);
  await page.getByTestId('setup-submit').click();

  // 2) create a project
  await expect(page.getByTestId('projects')).toBeVisible();
  await page.getByTestId('project-key').fill('EPRJ');
  await page.getByTestId('project-name').fill('E2E Project');
  await page.getByTestId('project-create').click();
  await expect(page.getByText('EPRJ · E2E Project')).toBeVisible();

  // 3) feature + five work items
  await page.getByTestId('nav-features').click();
  await expect(page.getByTestId('features')).toBeVisible();
  await page.getByTestId('feature-key').fill('FEAT');
  await page.getByTestId('feature-title').fill('Login flow');
  await page.getByTestId('feature-ac').fill('user can sign in');
  await page.getByTestId('feature-new').getByRole('button').click();
  await expect(page.getByTestId('feature-row')).toHaveCount(1);

  await page.getByTestId('nav-work-items').click();
  await expect(page.getByTestId('work-items')).toBeVisible();
  for (let i = 1; i <= 5; i++) {
    await page.getByTestId('wi-title').fill(`Item ${i}`);
    await page.getByTestId('wi-create').click();
    await expect(page.getByTestId('wi-list').getByTestId('wi-link')).toHaveCount(i);
  }

  // 4) board drag moves an item server-side (via the transition endpoint)
  await page.getByTestId('wi-tab-board').click();
  await expect(page.getByTestId('wi-board')).toBeVisible();
  const card = page.getByTestId('board-card').first();
  const key = (await card.locator('a').textContent())!.trim();
  const beforeState = (await (await page.request.get(`/api/v1/work-items/${key}`)).json()).state_name as string;
  // Release near the top of the target column on purpose: `dragTo` defaults to the
  // element's centre, and on a tall column that centre is below the fold, so
  // Playwright scrolls the *target* into view after the mouse is already down —
  // the press then lands on a card two rows lower and the dragged item is not the
  // one whose key was read above (measured: app moved EPRJ-3, spec polled EPRJ-5).
  // Pinning the point keeps the gesture on the intended card without weakening it.
  await card.dragTo(page.getByTestId('board-col').nth(2), { targetPosition: { x: 20, y: 60 } });
  await expect(card).toContainText(key); // the card under the pointer is still the item we keyed on
  await expect
    .poll(async () => (await (await page.request.get(`/api/v1/work-items/${key}`)).json()).state_name)
    .not.toBe(beforeState);

  // 5) fake AI provider + plan: create → generate → approve → apply (separate)
  await page.getByTestId('nav-ai-providers').click();
  await page.getByTestId('provider-name').fill('fake-e2e');
  await page.getByTestId('provider-kind').selectOption('fake');
  await page.getByTestId('provider-create').click();
  await expect(page.getByTestId('provider-row')).toHaveCount(1);

  await page.getByTestId('nav-planner').click();
  await page.getByTestId('plan-goal').fill('Ship the E2E milestone');
  await page.getByTestId('plan-create').click();
  await expect(page.getByTestId('plan-status')).toHaveText('generating');
  await page.getByTestId('plan-generate').click();
  await expect(page.getByTestId('plan-status')).toHaveText('ready');
  await page.getByTestId('plan-approve').click();
  await expect(page.getByTestId('plan-status')).toHaveText('approved');
  await page.getByTestId('plan-apply').click();
  await expect(page.getByTestId('plan-report')).toContainText('work_items');

  // 6) API key: raw shown exactly once. Wait for the page's initial list GET
  // to settle first — the lazy route mounts async and ngModel must be wired
  // before the fill lands (same race class as the flagship fix in #2).
  await page.getByTestId('nav-api-keys').click();
  await page
    .waitForResponse((r) => /\/api\/v1\/api-keys($|\?)/.test(r.url()) && r.request().method() === 'GET', { timeout: 30_000 })
    .catch(() => null);
  await expect(page.getByTestId('apikey-name')).toBeEditable();
  await page.getByTestId('apikey-name').fill('mcp-e2e');
  await expect(page.getByTestId('apikey-name')).toHaveValue('mcp-e2e');
  const created = page
    .waitForResponse((r) => r.request().method() === 'POST' && /\/api\/v1\/api-keys$/.test(r.url()), { timeout: 30_000 })
    .catch(() => null);
  await page.getByTestId('apikey-create').click();
  const resp = await created;
  if (resp && !resp.ok()) throw new Error(`api-key create failed ${resp.status()}: ${await resp.text()}`);
  await expect(page.getByTestId('apikey-raw')).toBeVisible();
  await expect(page.getByTestId('apikey-raw')).toContainText('fpm_');

  // 7) drive the Streamable-HTTP MCP server with the fresh key → tool call log
  const rawKey = (await page.getByTestId('apikey-raw').textContent())!.trim();
  const mcp = (id: number, method: string, params: unknown) =>
    page.request.post('/mcp', {
      headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
      data: { jsonrpc: '2.0', id, method, params },
    });
  expect((await mcp(1, 'tools/list', {})).ok()).toBe(true);
  const call = await mcp(2, 'tools/call', { name: 'project_list', arguments: {} });
  expect(call.ok()).toBe(true);
  await page.getByTestId('nav-mcp').click();
  await expect(page.getByTestId('mcp')).toBeVisible();
  await expect(page.getByTestId('mcp-calls').getByTestId('mcp-call-row').filter({ hasText: 'project_list' })).toBeVisible();

  // 8) GitHub: guidance while off → store config → enable at runtime → repo
  await page.getByTestId('nav-github').click();
  await expect(page.getByTestId('gh-disabled')).toBeVisible();
  await page.getByTestId('gh-app-id').fill('12345');
  await page.getByTestId('gh-private-key').fill('-----FAKE PEM-----');
  await page.getByTestId('gh-webhook-secret').fill('whsec_e2e');
  await page.getByTestId('gh-save').click();
  await expect(page.getByTestId('gh-msg')).toContainText('github.app_id');
  await page.getByTestId('nav-system').click();
  await page.getByTestId('module-row').filter({ hasText: 'github' }).getByTestId('module-toggle').click();

  // connect a repo through the manual PR path (same core the webhook feeds).
  // `page.request` shares the browser cookie jar (session is httpOnly), so the
  // mutation only needs the readable CSRF cookie echoed as a header (§5.3).
  const csrf = await page.evaluate(() => {
    const m = document.cookie.match(/(?:^|;\s*)fpm_csrf=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  });
  const pid = await page.evaluate(() => localStorage.getItem('fpm_project') ?? '');
  const pr = await page.request.post(`/api/v1/projects/${pid}/pull-requests`, {
    headers: { 'x-csrf-token': csrf },
    data: {
      repository_external_id: 'r-e2e', repository_full_name: 'e2e/repo', pr_external_id: 'pr-e2e',
      number: 1, title: 'E2E PR', state: 'open', draft: false, head_ref: 'feat/e2e', action: 'opened', merged: false,
    },
  });
  expect(pr.status(), await pr.text()).toBe(201);
  await page.getByTestId('nav-github').click();
  await expect(page.getByTestId('gh-repo-row')).toContainText('e2e/repo');

  // 9) Code review with the fake provider: enable module → run → completed run
  await page.getByTestId('nav-system').click();
  await page.getByTestId('module-row').filter({ hasText: 'code_review' }).getByTestId('module-toggle').click();
  await page.getByTestId('nav-reviews').click();
  await expect(page.getByTestId('review-run-form')).toBeVisible();
  await expect(page.getByTestId('review-repo')).toContainText('e2e/repo');
  await page.getByTestId('review-pr').fill('1');
  await page.getByTestId('review-run').click();
  await expect(page.getByTestId('run-row')).toHaveCount(1);
  await expect(page.getByTestId('run-row')).toContainText('completed');
});

test('§11 fa/RTL + axe on the major pages', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);

  for (const [path, testid] of [
    ['/projects', 'projects'],
    ['/work-items', 'work-items'],
    ['/features', 'features'],
    ['/planner', 'planner'],
    ['/api-keys', 'api-keys'],
    ['/system', 'system'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByTestId(testid)).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious, `${path}: ${JSON.stringify(serious)}`).toHaveLength(0);
  }

  // Persian + RTL: toggle flips the document and the nav is translated.
  await page.getByTestId('lang-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fa');
  await expect(page.getByTestId('nav-projects')).toContainText('پروژه‌ها');
  await page.getByTestId('lang-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

  // §11: no horizontal overflow at 360 and 1280 px on the major pages.
  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [path, testid] of [
      ['/projects', 'projects'],
      ['/work-items', 'work-items'],
      ['/features', 'features'],
      ['/system', 'system'],
    ] as const) {
      await page.goto(path);
      await expect(page.getByTestId(testid)).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${path} at ${width}px overflows by ${overflow}px`).toBeLessThanOrEqual(0);
    }
  }
});

// Settings page: cards moved from System (modules, backups, GitHub status), appearance, and the search filter.
import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ApiClient } from '../api';
import { I18n } from '../i18n';
import { Tokens } from '../ui/tokens';
import { SettingsPage } from './settings';

interface Calls {
  put: unknown[][];
  post: unknown[][];
}

async function mount() {
  const calls: Calls = { put: [], post: [] };
  const api: Partial<ApiClient> = {
    get: async <T = unknown>(url?: string): Promise<T> => {
      if (url?.endsWith('/system/health')) {
        return {
          database: 'ok',
          redis: 'ok',
          modules: [
            { name: 'github', enabled: false, registered: true },
            { name: 'code_review', enabled: true, registered: true },
          ],
        } as T;
      }
      if (url?.endsWith('/github/status')) return { app_id_set: true, private_key_set: false, webhook_secret_set: true, enabled: false } as T;
      if (url?.endsWith('/settings/registry')) {
        return {
          settings: [
            { key: 'review.auto_run', category: 'review', default: false },
            { key: 'github.issue_sync_mode', category: 'github', default: 'off' },
            { key: 'exec.policy', category: 'exec', default: 'auto' },
          ],
        } as T;
      }
      if (url?.includes('/settings/effective')) {
        const key = new URL(url, 'http://x').searchParams.get('key');
        return { key, value: key === 'github.issue_sync_mode' ? 'off' : false, source: 'default' } as T;
      }
      return { items: [] } as T;
    },
    put: async <T = unknown>(...a: unknown[]): Promise<T> => (calls.put.push(a), {} as T),
    post: async <T = unknown>(...a: unknown[]): Promise<T> => (calls.post.push(a), {} as T),
  };
  localStorage.removeItem('fpm_project');
  TestBed.configureTestingModule({ imports: [SettingsPage], providers: [{ provide: ApiClient, useValue: api }] });
  const f = TestBed.createComponent(SettingsPage);
  f.detectChanges();
  for (let i = 0; i < 20; i++) {
    await f.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    f.detectChanges();
  }
  return { f, el: f.nativeElement as HTMLElement, calls };
}

const q = <T extends HTMLElement>(el: HTMLElement, id: string): T => el.querySelector(`[data-testid="${id}"]`) as T;

describe('SettingsPage', () => {
  it('cards: modules with switches, backups and the GitHub status card render', async () => {
    const { f, el, calls } = await mount();
    const switches = Array.from(el.querySelectorAll<HTMLButtonElement>('[data-testid="module-toggle"]'));
    expect(switches.map((s) => s.getAttribute('role'))).toEqual(['switch', 'switch']);
    expect(switches.map((s) => s.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    const rows = el.querySelectorAll('[data-testid="module-row"]');
    expect(rows[0].textContent).toContain('Github');
    expect(rows[1].textContent).toContain('CodeReview');
    switches[0].click();
    await f.whenStable();
    expect(calls.put[0]).toEqual(['/api/v1/modules/github/enabled', { enabled: true }]);
    expect(q(el, 'backups-card')).toBeTruthy();
    expect(q(el, 'backup-run')).toBeTruthy();
    const status = q(el, 'gh-status');
    expect(status.querySelectorAll('.ui-badge--success').length).toBe(2);
    expect(status.querySelectorAll('.ui-badge').length).toBe(4);
  });

  it('search filter: every typed character narrows the settings rows', async () => {
    const { f, el } = await mount();
    const count = () => q(el, 'settings-count').textContent?.trim();
    expect(count()).toBe('3');
    const input = q<HTMLInputElement>(el, 'settings-search');
    const type = (v: string) => {
      input.value = v;
      input.dispatchEvent(new Event('input'));
      f.detectChanges();
    };
    type('r');
    const afterR = Number(count());
    type('re');
    expect(Number(count())).toBeLessThanOrEqual(afterR);
    type('review');
    expect(count()).toBe('1');
    type('zzz');
    expect(count()).toBe('0');
    type('');
    expect(count()).toBe('3');
  });

  it('appearance: the theme and language selects change the theme and the language', async () => {
    const { f, el } = await mount();
    const tokens = TestBed.inject(Tokens);
    const i18n = TestBed.inject(I18n);
    i18n.set('en');
    const theme = q<HTMLSelectElement>(el, 'theme-select');
    theme.value = 'dark';
    theme.dispatchEvent(new Event('change'));
    f.detectChanges();
    expect(tokens.theme()).toBe('dark');
    const lang = q<HTMLSelectElement>(el, 'lang-select');
    lang.value = 'fa';
    lang.dispatchEvent(new Event('change'));
    f.detectChanges();
    expect(i18n.lang()).toBe('fa');
    i18n.set('en');
    tokens.set('system');
  });
});

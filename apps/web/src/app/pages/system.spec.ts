// System page: health cards, module switches, and errors surfaced as toasts.
import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ApiClient } from '../api';
import { UiToastService } from '../ui/toast';
import { SystemPage } from './system';

const HEALTH = {
  database: 'ok',
  redis: 'down',
  modules: [
    { name: 'github', enabled: false, registered: true },
    { name: 'exec', enabled: true, registered: true },
  ],
};

async function mount(api: Partial<ApiClient>) {
  TestBed.configureTestingModule({ imports: [SystemPage], providers: [{ provide: ApiClient, useValue: api }] });
  const f = TestBed.createComponent(SystemPage);
  f.detectChanges();
  await f.whenStable();
  f.detectChanges();
  return f;
}

function okApi(calls: unknown[][] = []): Partial<ApiClient> {
  return {
    get: async <T = unknown>(url: string): Promise<T> => (url.endsWith('/health') ? HEALTH : { items: [] }) as T,
    put: async <T = unknown>(...args: unknown[]): Promise<T> => {
      calls.push(args);
      return {} as T;
    },
  };
}

describe('SystemPage', () => {
  it('health-cards: database and redis render a status indicator class', async () => {
    const f = await mount(okApi());
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="sys-db"]')?.classList.contains('ui-health--ok')).toBe(true);
    expect(el.querySelector('[data-testid="sys-redis"]')?.classList.contains('ui-health--down')).toBe(true);
    expect(el.querySelector('[data-testid="sys-redis"] .ui-health-title')?.textContent).toContain('Redis');
  });

  it('module-toggle: renders a switch reflecting enabled and calls the enable endpoint on click', async () => {
    const calls: unknown[][] = [];
    const f = await mount(okApi(calls));
    const el = f.nativeElement as HTMLElement;
    const switches = Array.from(el.querySelectorAll<HTMLButtonElement>('[data-testid="module-toggle"]'));
    expect(switches.map((s) => s.getAttribute('role'))).toEqual(['switch', 'switch']);
    expect(switches.map((s) => s.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    switches[0].click();
    await f.whenStable();
    expect(calls[0]).toEqual(['/api/v1/modules/github/enabled', { enabled: true }]);
  });

  it('error-toast: a failed load raises exactly one error toast and no inline paragraph', async () => {
    const api: Partial<ApiClient> = {
      get: async () => {
        throw new Error('github module requires all secrets to be configured');
      },
    };
    const f = await mount(api);
    const el = f.nativeElement as HTMLElement;
    const toasts = TestBed.inject(UiToastService).toasts();
    expect(toasts.filter((t) => t.kind === 'error').map((t) => t.message)).toEqual([
      'github module requires all secrets to be configured',
    ]);
    expect(el.querySelector('.ui-error')).toBeNull();
    expect(el.querySelector('[data-testid="system-error"]')).toBeNull();
  });
});

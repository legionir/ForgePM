// AI providers page: create/edit form lives in a modal opened from the card header.
import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ApiClient } from '../api';
import { AiProvidersPage } from './ai-providers';

const PROVIDERS = [
  { id: 'a1', name: 'main', kind: 'openai_compatible', base_url: 'https://x/v1', default_model: 'gpt-x', enabled: true, key_last4: '1234' },
  { id: 'a2', name: 'offline', kind: 'fake', base_url: null, default_model: null, enabled: false, key_last4: null },
];

async function mount() {
  const calls: { post: unknown[][]; put: unknown[][] } = { post: [], put: [] };
  const api: Partial<ApiClient> = {
    get: async <T = unknown>(): Promise<T> => ({ items: PROVIDERS, used_tokens_today: 7 }) as T,
    post: async <T = unknown>(...a: unknown[]): Promise<T> => (calls.post.push(a), ({ items: [] }) as T),
    put: async <T = unknown>(...a: unknown[]): Promise<T> => (calls.put.push(a), {} as T),
  };
  TestBed.configureTestingModule({ imports: [AiProvidersPage], providers: [{ provide: ApiClient, useValue: api }] });
  const f = TestBed.createComponent(AiProvidersPage);
  for (let i = 0; i < 4; i++) {
    f.detectChanges();
    await f.whenStable();
  }
  f.detectChanges();
  return { f, el: f.nativeElement as HTMLElement, calls };
}

const q = <T extends HTMLElement>(el: HTMLElement, id: string): T => el.querySelector(`[data-testid="${id}"]`) as T;
const settle = async (f: { detectChanges(): void; whenStable(): Promise<unknown> }) => {
  f.detectChanges();
  await f.whenStable();
  f.detectChanges();
};

describe('AiProvidersPage', () => {
  it('provider modal: the form is hidden until the header button opens a modal that posts the provider', async () => {
    const { f, el, calls } = await mount();
    expect(q(el, 'provider-count').textContent?.trim()).toBe('2');
    expect(q(el, 'provider-new')).toBeNull();
    q<HTMLButtonElement>(el, 'provider-new-open').click();
    await settle(f);
    expect(q(el, 'modal')).toBeTruthy();
    expect(q(el, 'provider-new')).toBeTruthy();
    const name = q<HTMLInputElement>(el, 'provider-name');
    name.value = 'new-one';
    name.dispatchEvent(new Event('input'));
    f.detectChanges();
    q<HTMLButtonElement>(el, 'provider-create').click();
    await settle(f);
    const created = calls.post.find((c) => c[0] === '/api/v1/ai-providers');
    expect(created).toEqual(['/api/v1/ai-providers', { name: 'new-one', kind: 'fake' }]);
    expect(q(el, 'modal')).toBeNull();
  });

  it('status badges and CamelCase: rows show kind and enabled state as icon badges', async () => {
    const { el } = await mount();
    const rows = el.querySelectorAll('[data-testid="provider-row"]');
    expect(rows[0].textContent).toContain('OpenaiCompatible');
    expect(rows[0].querySelector('.ui-badge--success')?.textContent?.trim()).toBe('Enabled');
    expect(rows[1].querySelector('.ui-badge ui-icon')).toBeTruthy();
    expect(rows[1].textContent).toContain('Disabled');
  });

  it('edit opens the same modal prefilled and saves through PUT', async () => {
    const { f, el, calls } = await mount();
    el.querySelectorAll<HTMLButtonElement>('[data-testid="provider-edit"]')[0].click();
    await settle(f);
    expect(q<HTMLInputElement>(el, 'provider-name').value).toBe('main');
    q<HTMLButtonElement>(el, 'provider-create').click();
    await settle(f);
    expect(calls.put[0][0]).toBe('/api/v1/ai-providers/a1');
    expect(q(el, 'modal')).toBeNull();
  });
});

// GitHub page: connected indicator, green link / red unlink icons, repository search.
import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ApiClient } from '../api';
import { ProjectContext } from '../project-context';
import { GithubPage } from './github';

const REPOS = [
  { id: 'r1', full_name: 'acme/forge', external_id: '1' },
  { id: 'r2', full_name: 'acme/rdm', external_id: '2' },
  { id: 'r3', full_name: 'other/tool', external_id: '3' },
];

async function mount() {
  const calls: { post: unknown[][]; send: unknown[][] } = { post: [], send: [] };
  let connected = ['r1'];
  const api: Partial<ApiClient> = {
    get: async <T = unknown>(url?: string): Promise<T> => {
      if (url === '/api/v1/projects') return { items: [{ id: 'p1', key: 'SSS', name: 'sss', status: 'active' }] } as T;
      if (url?.endsWith('/github/status')) return { app_id_set: true, private_key_set: true, webhook_secret_set: true, enabled: true } as T;
      if (url === '/api/v1/repositories') return { items: REPOS } as T;
      if (url?.endsWith('/p1/repositories')) return { items: REPOS.filter((r) => connected.includes(r.id)) } as T;
      return { items: [] } as T;
    },
    post: async <T = unknown>(...a: unknown[]): Promise<T> => {
      calls.post.push(a);
      connected = [...connected, (a[1] as { repository_id: string }).repository_id];
      return {} as T;
    },
    send: async <T = unknown>(...a: unknown[]): Promise<T> => {
      calls.send.push(a);
      connected = connected.filter((id) => !String(a[1]).endsWith(id));
      return {} as T;
    },
  };
  localStorage.setItem('fpm_project', 'p1');
  TestBed.configureTestingModule({ imports: [GithubPage], providers: [{ provide: ApiClient, useValue: api }] });
  TestBed.inject(ProjectContext).selectedId.set('p1');
  const f = TestBed.createComponent(GithubPage);
  for (let i = 0; i < 6; i++) {
    f.detectChanges();
    await f.whenStable();
    await new Promise((r) => setTimeout(r, 0));
  }
  f.detectChanges();
  return { f, el: f.nativeElement as HTMLElement, calls };
}

const q = <T extends HTMLElement>(el: HTMLElement, id: string): T => el.querySelector(`[data-testid="${id}"]`) as T;
const rows = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>('[data-testid="gh-repo-row"]'));
const settle = async (f: { detectChanges(): void; whenStable(): Promise<unknown> }) => {
  for (let i = 0; i < 3; i++) {
    f.detectChanges();
    await f.whenStable();
    await new Promise((r) => setTimeout(r, 0));
  }
  f.detectChanges();
};

describe('GithubPage', () => {
  it('link and unlink icons: the connected repository shows a red unlink icon, the others a green link icon', async () => {
    const { f, el, calls } = await mount();
    const [r1, r2] = rows(el);
    expect(r1.querySelector('[data-testid="gh-unlink"].ui-link-btn--off')).toBeTruthy();
    expect(r1.querySelector('[data-testid="gh-connected"]')?.textContent?.trim()).toBe('Connected');
    expect(r2.querySelector('[data-testid="gh-link"].ui-link-btn--on')).toBeTruthy();
    expect(r2.querySelector('[data-testid="gh-connected"]')).toBeNull();
    expect(q(el, 'gh-connected-count').textContent?.trim()).toBe('1');

    r2.querySelector<HTMLButtonElement>('[data-testid="gh-link"]')!.click();
    await settle(f);
    expect(calls.post).toEqual([['/api/v1/projects/p1/repositories', { repository_id: 'r2' }]]);
    expect(rows(el)[1].querySelector('[data-testid="gh-unlink"]')).toBeTruthy();

    rows(el)[0].querySelector<HTMLButtonElement>('[data-testid="gh-unlink"]')!.click();
    await settle(f);
    expect(calls.send).toEqual([['DELETE', '/api/v1/projects/p1/repositories/r1']]);
    expect(rows(el)[0].querySelector('[data-testid="gh-link"]')).toBeTruthy();
  });

  it('repository search: every typed character narrows the list', async () => {
    const { f, el } = await mount();
    const input = q<HTMLInputElement>(el, 'gh-search');
    const type = (v: string) => {
      input.value = v;
      input.dispatchEvent(new Event('input'));
      f.detectChanges();
    };
    expect(rows(el).length).toBe(3);
    type('e');
    expect(rows(el).length).toBe(3);
    type('acme');
    expect(rows(el).length).toBe(2);
    type('acme/r');
    expect(rows(el).map((r) => r.textContent?.trim())).toEqual([expect.stringContaining('acme/rdm')]);
    type('zzz');
    expect(rows(el).length).toBe(0);
    expect(q(el, 'gh-repos-empty')).toBeTruthy();
    type('');
    expect(rows(el).length).toBe(3);
    expect(q(el, 'gh-count').textContent?.trim()).toBe('3');
  });

  it('the configured status text is no longer part of this page', async () => {
    const { el } = await mount();
    expect(q(el, 'gh-status')).toBeNull();
  });
});

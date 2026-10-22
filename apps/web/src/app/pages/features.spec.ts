// Features page: header actions + modals, creation payloads, status changes and badges.
import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ApiClient } from '../api';
import { ProjectContext } from '../project-context';
import { FeaturesPage } from './features';

const FEATURES = [
  { id: 'f1', key: 'AUTH', title: 'Login', lifecycle_status: 'in_progress', milestone_id: 'm1', work_progress: 40, release_readiness: 10, acceptance_criteria: [] },
  { id: 'f2', key: 'PAY', title: 'Payments', lifecycle_status: 'released', milestone_id: null, work_progress: 100, release_readiness: 100, acceptance_criteria: [] },
];
const MILESTONES = [{ id: 'm1', name: 'beta release', target_date: '2026-12-01', status: 'open', progress: 20 }];

interface Calls {
  post: unknown[][];
  patch: unknown[][];
}

async function mount() {
  const calls: Calls = { post: [], patch: [] };
  const api: Partial<ApiClient> = {
    get: async <T = unknown>(url?: string): Promise<T> => ({ items: url?.endsWith('/features') ? FEATURES : url?.endsWith('/milestones') ? MILESTONES : [] }) as T,
    post: async <T = unknown>(...a: unknown[]): Promise<T> => (calls.post.push(a), {} as T),
    patch: async <T = unknown>(...a: unknown[]): Promise<T> => (calls.patch.push(a), {} as T),
  };
  localStorage.setItem('fpm_project', 'p1');
  TestBed.configureTestingModule({ imports: [FeaturesPage], providers: [{ provide: ApiClient, useValue: api }] });
  TestBed.inject(ProjectContext).selectedId.set('p1');
  const f = TestBed.createComponent(FeaturesPage);
  for (let i = 0; i < 6; i++) {
    f.detectChanges();
    await f.whenStable();
    await new Promise((r) => setTimeout(r, 0));
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
function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

describe('FeaturesPage', () => {
  it('header actions and modals: count badges, New buttons in the headers, forms only inside modals', async () => {
    const { f, el } = await mount();
    expect(q(el, 'feature-count').textContent?.trim()).toBe('2');
    expect(q(el, 'milestone-count').textContent?.trim()).toBe('1');
    expect(el.querySelectorAll('.ui-card-head h2 ui-icon').length).toBe(2);
    expect(q(el, 'feature-new')).toBeNull();
    expect(q(el, 'milestone-new')).toBeNull();
    q<HTMLButtonElement>(el, 'feature-new-open').click();
    await settle(f);
    expect(q(el, 'modal')).toBeTruthy();
    expect(q(el, 'feature-new')).toBeTruthy();
  });

  it('create feature: posts key, title, description, milestone and criteria, then closes the modal', async () => {
    const { f, el, calls } = await mount();
    q<HTMLButtonElement>(el, 'feature-new-open').click();
    await settle(f);
    type(q<HTMLInputElement>(el, 'feature-key'), 'SRCH');
    type(q<HTMLInputElement>(el, 'feature-title'), 'Search');
    type(q<HTMLTextAreaElement>(el, 'feature-description'), 'find things');
    const ms = q<HTMLSelectElement>(el, 'feature-milestone');
    ms.value = 'm1';
    ms.dispatchEvent(new Event('change'));
    type(q<HTMLInputElement>(el, 'feature-ac'), 'returns results');
    await settle(f);
    expect(q(el, 'criteria-count').textContent?.trim()).toBe('1');
    q<HTMLButtonElement>(el, 'feature-create').click();
    await settle(f);
    expect(calls.post).toEqual([
      [
        '/api/v1/projects/p1/features',
        { key: 'SRCH', title: 'Search', description: 'find things', milestone_id: 'm1', acceptance_criteria: [{ text: 'returns results', done: false }] },
      ],
    ]);
    expect(q(el, 'modal')).toBeNull();
  });

  it('create milestone: posts name and target_date', async () => {
    const { f, el, calls } = await mount();
    q<HTMLButtonElement>(el, 'milestone-new-open').click();
    await settle(f);
    type(q<HTMLInputElement>(el, 'milestone-name'), 'GA');
    type(q<HTMLInputElement>(el, 'milestone-date'), '2027-01-15');
    await settle(f);
    q<HTMLButtonElement>(el, 'milestone-create').click();
    await settle(f);
    expect(calls.post).toEqual([['/api/v1/projects/p1/milestones', { name: 'GA', target_date: '2027-01-15' }]]);
  });

  it('change status: lifecycle, feature milestone and milestone status are PATCHed', async () => {
    const { f, el, calls } = await mount();
    const lifecycle = el.querySelectorAll<HTMLSelectElement>('[data-testid="feature-status-select"]')[0];
    lifecycle.value = 'in_validation';
    lifecycle.dispatchEvent(new Event('change'));
    await settle(f);
    const milestone = el.querySelectorAll<HTMLSelectElement>('[data-testid="feature-milestone-select"]')[1];
    milestone.value = 'm1';
    milestone.dispatchEvent(new Event('change'));
    await settle(f);
    const status = q<HTMLSelectElement>(el, 'milestone-status-select');
    status.value = 'closed';
    status.dispatchEvent(new Event('change'));
    await settle(f);
    expect(calls.patch).toEqual([
      ['/api/v1/features/f1', { lifecycle_status: 'in_validation' }],
      ['/api/v1/features/f2', { milestone_id: 'm1' }],
      ['/api/v1/milestones/m1', { status: 'closed' }],
    ]);
  });

  it('status badges: coloured, with an icon and a CamelCase label; milestone shows its feature count', async () => {
    const { el } = await mount();
    const badges = Array.from(el.querySelectorAll<HTMLElement>('[data-testid="feature-status"]'));
    expect(badges.map((b) => b.textContent?.trim())).toEqual(['InProgress', 'Released']);
    expect(badges[0].classList.contains('ui-badge--info')).toBe(true);
    expect(badges[1].classList.contains('ui-badge--success')).toBe(true);
    expect(badges.every((b) => b.querySelector('ui-icon'))).toBe(true);
    const ms = q(el, 'milestone-status');
    expect(ms.textContent?.trim()).toBe('Open');
    expect(q(el, 'milestone-features').textContent?.trim()).toBe('1');
    const options = Array.from(el.querySelectorAll('[data-testid="feature-status-select"]:first-of-type option')).map((o) => o.textContent?.trim());
    expect(options).toContain('InValidation');
  });

  it('no visible criterion label: the criteria input is named only through aria-label', async () => {
    const { f, el } = await mount();
    q<HTMLButtonElement>(el, 'feature-new-open').click();
    await settle(f);
    expect(q(el, 'modal').textContent).not.toContain('Acceptance criterion');
    expect(q(el, 'feature-ac').getAttribute('aria-label')).toBe('Acceptance criterion');
  });
});

// Work items page: create modal, status badges and CamelCase dropdowns.
import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiClient } from '../api';
import { ProjectContext } from '../project-context';
import { WorkItemsPage } from './work-items';

const STATES = [
  { id: 's1', name: 'Backlog', category: 'backlog', position: 0 },
  { id: 's2', name: 'In Progress', category: 'started', position: 1 },
];
const ITEMS = [
  { id: 'i1', key: 'SSS-1', title: 'First', type: 'feature_task', priority: 'urgent', state_id: 's2', state_name: 'In Progress', state_category: 'started', labels: [], comment_count: 0, due_date: null, acceptance_criteria: [], assignee_user_id: null, assignee_agent_id: null },
];

async function mount() {
  const posts: unknown[][] = [];
  const api: Partial<ApiClient> = {
    get: async <T = unknown>(url?: string): Promise<T> => {
      if (url === '/api/v1/projects') return { items: [{ id: 'p1', key: 'SSS', name: 'sss', status: 'active' }] } as T;
      if (url?.endsWith('/states')) return { items: STATES } as T;
      if (url?.includes('/work-items')) return { items: ITEMS } as T;
      if (url?.endsWith('/milestones')) return { items: [{ id: 'm1', name: 'beta' }] } as T;
      if (url?.endsWith('/features')) return { items: [{ id: 'f1', key: 'AUTH', title: 'login' }] } as T;
      return { items: [] } as T;
    },
    post: async <T = unknown>(...a: unknown[]): Promise<T> => (posts.push(a), {} as T),
  };
  localStorage.setItem('fpm_project', 'p1');
  TestBed.configureTestingModule({ imports: [WorkItemsPage], providers: [provideRouter([]), { provide: ApiClient, useValue: api }] });
  TestBed.inject(ProjectContext).selectedId.set('p1');
  const f = TestBed.createComponent(WorkItemsPage);
  for (let i = 0; i < 6; i++) {
    f.detectChanges();
    await f.whenStable();
    await new Promise((r) => setTimeout(r, 0));
  }
  f.detectChanges();
  return { f, el: f.nativeElement as HTMLElement, posts };
}

const q = <T extends HTMLElement>(el: HTMLElement, id: string): T => el.querySelector(`[data-testid="${id}"]`) as T;
const settle = async (f: { detectChanges(): void; whenStable(): Promise<unknown> }) => {
  for (let i = 0; i < 3; i++) {
    f.detectChanges();
    await f.whenStable();
    await new Promise((r) => setTimeout(r, 0));
  }
  f.detectChanges();
};
function choose(sel: HTMLSelectElement, value: string): void {
  sel.value = value;
  sel.dispatchEvent(new Event('change'));
}

describe('WorkItemsPage', () => {
  it('create modal: header button opens it and the payload carries type, state, priority, milestone and feature', async () => {
    const { f, el, posts } = await mount();
    expect(q(el, 'wi-count').textContent?.trim()).toBe('1');
    expect(q(el, 'wi-new')).toBeNull();
    q<HTMLButtonElement>(el, 'wi-new-open').click();
    await settle(f);
    expect(q(el, 'modal')).toBeTruthy();
    const title = q<HTMLInputElement>(el, 'wi-title');
    title.value = 'Ship it';
    title.dispatchEvent(new Event('input'));
    choose(q<HTMLSelectElement>(el, 'wi-type'), 'bug');
    choose(q<HTMLSelectElement>(el, 'wi-state'), 's2');
    choose(q<HTMLSelectElement>(el, 'wi-priority'), 'high');
    choose(q<HTMLSelectElement>(el, 'wi-milestone'), 'm1');
    choose(q<HTMLSelectElement>(el, 'wi-feature'), 'f1');
    await settle(f);
    q<HTMLButtonElement>(el, 'wi-create').click();
    await settle(f);
    expect(posts).toEqual([
      ['/api/v1/projects/p1/work-items', { type: 'bug', title: 'Ship it', state_id: 's2', priority: 'high', milestone_id: 'm1', feature_id: 'f1' }],
    ]);
    expect(q(el, 'modal')).toBeNull();
  });

  it('status badges: priority and state are coloured icon badges in CamelCase', async () => {
    const { el } = await mount();
    const row = q(el, 'wi-list').querySelector('tbody tr') as HTMLElement;
    const badges = Array.from(row.querySelectorAll('ui-badge')).map((b) => b.textContent?.trim());
    expect(badges).toContain('Urgent');
    expect(badges).toContain('InProgress');
    expect(row.querySelector('.ui-badge--error ui-icon')).toBeTruthy();
    expect(row.querySelector('.ui-badge--info ui-icon')).toBeTruthy();
    expect(row.textContent).toContain('FeatureTask');
  });

  it('camel options: type, state, priority and the state-category filter show CamelCase text', async () => {
    const { f, el } = await mount();
    q<HTMLButtonElement>(el, 'wi-new-open').click();
    await settle(f);
    const texts = (id: string) => Array.from(q(el, id).querySelectorAll('option')).map((o) => o.textContent?.trim());
    expect(texts('wi-type')).toContain('FeatureTask');
    expect(texts('wi-state')).toEqual(['Backlog', 'InProgress']);
    expect(texts('wi-priority')).toEqual(['None', 'Low', 'Medium', 'High', 'Urgent']);
    expect(texts('wi-filter')).toContain('InReview');
  });
});

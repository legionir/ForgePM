// Execution tasks page: route-driven detail modal, selects instead of free text, no JSON previews.
import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ApiClient } from '../api';
import { ProjectContext } from '../project-context';
import { UiToastService } from '../ui/toast';
import { ExecTasksPage, FACT_SOURCES, RESOLVE_STATUSES } from './exec-tasks';

const node = (code: string, title: string) => ({
  id: code, code, title, status: 'not_started', display_status: 'not_started', parent_id: null, blocked_on: null,
  depends_on: [], declared_req_ids: [], criteria: [], children: [],
});

const DETAILS: Record<string, unknown> = {
  'T-001': {
    task: { code: 'T-001', title: 'first task', status: 'in_progress', allowed_paths: ['apps/**'] },
    criteria: [
      { code: 'C-1', text: 'the first criterion must pass', status: 'pending', req_code: null },
      { code: 'C-2', text: 'the second criterion', status: 'verified', req_code: null },
    ],
    evidence: [],
    items: [
      { code: 'OI-001', title: 'open one', type: 'bug', status: 'open', blocks_completion: true },
      { code: 'OI-002', title: 'closed one', type: 'bug', status: 'resolved', blocks_completion: false },
    ],
    questions: [{ code: 'Q-001', question: 'which db?', status: 'open', blocking: true, options: [] }],
    decisions: [{ code: 'D-001', title: 'use pg', status: 'proposed', approval_state: 'pending' }],
    reviews: [],
    journal: [],
    requirements: [{ code: 'REQ-001', text: 'must be fast', status: 'active' }],
  },
  'T-002': {
    task: { code: 'T-002', title: 'second task', status: 'not_started', allowed_paths: [] },
    criteria: [], evidence: [], items: [], questions: [], decisions: [], reviews: [], journal: [], requirements: [],
  },
};

async function mount() {
  const posts: unknown[][] = [];
  const api: Partial<ApiClient> = {
    get: async <T = unknown>(url?: string): Promise<T> => {
      if (url === '/api/v1/projects') return { items: [{ id: 'p1', key: 'SSS', name: 'sss', status: 'active' }] } as T;
      if (url?.startsWith('/api/v1/exec/plan')) return { roots: [node('T-001', 'first task'), node('T-002', 'second task')], task_count: 2, next_cursor: null } as T;
      const m = /task_ref=([A-Z0-9-]+)/.exec(url ?? '');
      if (url?.startsWith('/api/v1/exec/status') && m) return DETAILS[m[1]] as T;
      return { items: [] } as T;
    },
    post: async <T = unknown>(...a: unknown[]): Promise<T> => (posts.push(a), {} as T),
  };
  localStorage.setItem('fpm_project', 'p1');
  TestBed.configureTestingModule({
    providers: [provideRouter([{ path: 'exec-tasks', component: ExecTasksPage }, { path: 'exec-tasks/:code', component: ExecTasksPage }]), { provide: ApiClient, useValue: api }],
  });
  TestBed.inject(ProjectContext).selectedId.set('p1');
  const harness = await RouterTestingHarness.create();
  return { harness, posts, router: TestBed.inject(Router) };
}

const q = <T extends HTMLElement>(el: HTMLElement, id: string): T | null => el.querySelector(`[data-testid="${id}"]`) as T | null;
const settle = async (harness: RouterTestingHarness) => {
  for (let i = 0; i < 4; i++) {
    harness.detectChanges();
    await harness.fixture.whenStable();
    await new Promise((r) => setTimeout(r, 0));
  }
  harness.detectChanges();
};
const el = (h: RouterTestingHarness) => h.routeNativeElement as HTMLElement;
const titleOf = (h: RouterTestingHarness) => el(h).querySelector('.ui-modal-head h2')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
function choose(sel: HTMLSelectElement, value: string): void {
  sel.value = value;
  sel.dispatchEvent(new Event('change'));
}
function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

describe('ExecTasksPage', () => {
  it('route driven modal: /exec-tasks/:code opens the details and another code replaces them', async () => {
    const { harness } = await mount();
    await harness.navigateByUrl('/exec-tasks', ExecTasksPage);
    await settle(harness);
    expect(q(el(harness), 'modal')).toBeNull();
    expect(q(el(harness), 'exec-task-count')?.textContent?.trim()).toBe('2');

    await harness.navigateByUrl('/exec-tasks/T-001', ExecTasksPage);
    await settle(harness);
    expect(q(el(harness), 'modal')).toBeTruthy();
    expect(titleOf(harness)).toContain('T-001 · first task');
    expect(el(harness).querySelectorAll('[data-testid="exec-criterion-row"]').length).toBe(2);

    await harness.navigateByUrl('/exec-tasks/T-002', ExecTasksPage);
    await settle(harness);
    expect(titleOf(harness)).toContain('T-002 · second task');
    expect(el(harness).querySelectorAll('[data-testid="exec-criterion-row"]').length).toBe(0);
  });

  it('close then open another: closing returns to the list and the next click shows its details', async () => {
    const { harness, router } = await mount();
    await harness.navigateByUrl('/exec-tasks/T-001', ExecTasksPage);
    await settle(harness);
    q<HTMLButtonElement>(el(harness), 'modal-close')!.click();
    await settle(harness);
    expect(router.url).toBe('/exec-tasks');
    expect(q(el(harness), 'modal')).toBeNull();

    el(harness).querySelectorAll<HTMLAnchorElement>('[data-testid="exec-task-link"]')[1].click();
    await settle(harness);
    expect(router.url).toBe('/exec-tasks/T-002');
    expect(titleOf(harness)).toContain('T-002 · second task');
  });

  it('no json preview: the form values are never printed as JSON', async () => {
    const { harness } = await mount();
    await harness.navigateByUrl('/exec-tasks/T-001', ExecTasksPage);
    await settle(harness);
    const text = el(harness).textContent ?? '';
    expect(text).not.toContain('{"code"');
    expect(text).not.toContain('"source":"human"');
    expect(el(harness).querySelector('[data-testid$="-preview"]')).toBeNull();
  });

  it('enum selects: resolve status and fact source are selects with the API enum values and CamelCase labels', async () => {
    const { harness } = await mount();
    await harness.navigateByUrl('/exec-tasks/T-001', ExecTasksPage);
    await settle(harness);
    const status = q<HTMLSelectElement>(el(harness), 'exec-resolve-status')!;
    expect(status.tagName).toBe('SELECT');
    expect(Array.from(status.options).map((o) => o.value)).toEqual([...RESOLVE_STATUSES]);
    expect(Array.from(status.options).map((o) => o.textContent?.trim())).toEqual(['Resolved', 'Accepted', 'Deferred', 'WontFix', 'NotApplicable']);
    const source = q<HTMLSelectElement>(el(harness), 'exec-promote-source')!;
    expect(source.tagName).toBe('SELECT');
    expect(Array.from(source.options).map((o) => o.value)).toEqual([...FACT_SOURCES]);
    expect(Array.from(source.options).map((o) => o.textContent?.trim())).toEqual(['Human', 'Code', 'Docs', 'ToolOutput']);
  });

  it('code selects: each code field lists only the task\'s own matching rows', async () => {
    const { harness } = await mount();
    await harness.navigateByUrl('/exec-tasks/T-001', ExecTasksPage);
    await settle(harness);
    const values = (id: string) => Array.from(q<HTMLSelectElement>(el(harness), id)!.options).map((o) => o.value).filter(Boolean);
    expect(values('exec-resolve-code')).toEqual(['OI-001']); // the resolved item is not offered
    expect(values('exec-answer-code')).toEqual(['Q-001']);
    expect(values('exec-decide-code')).toEqual(['D-001']);
    expect(values('exec-waive-code')).toEqual(['C-1']); // the verified criterion is not offered
    expect(values('exec-drop-code')).toEqual(['REQ-001']);
  });

  it('reason minimum: a short reason keeps the action disabled and shows the count', async () => {
    const { harness } = await mount();
    await harness.navigateByUrl('/exec-tasks/T-001', ExecTasksPage);
    await settle(harness);
    choose(q<HTMLSelectElement>(el(harness), 'exec-waive-code')!, 'C-1');
    type(q<HTMLInputElement>(el(harness), 'exec-waive-reason')!, 'too short');
    await settle(harness);
    expect(q<HTMLButtonElement>(el(harness), 'exec-waive-submit')!.disabled).toBe(true);
    expect(q(el(harness), 'exec-waive-form')!.textContent).toContain('9/10');
    type(q<HTMLInputElement>(el(harness), 'exec-waive-reason')!, 'long enough reason');
    await settle(harness);
    expect(q<HTMLButtonElement>(el(harness), 'exec-waive-submit')!.disabled).toBe(false);

    choose(q<HTMLSelectElement>(el(harness), 'exec-resolve-code')!, 'OI-001');
    type(q<HTMLTextAreaElement>(el(harness), 'exec-resolve-note')!, 'twenty is the minimum');
    await settle(harness);
    expect(q<HTMLButtonElement>(el(harness), 'exec-resolve-submit')!.disabled).toBe(false);
    type(q<HTMLTextAreaElement>(el(harness), 'exec-resolve-note')!, 'too short for resolve');
    await settle(harness);
    expect(q(el(harness), 'exec-resolve-form')!.textContent).not.toContain('/20'); // exactly 20 is accepted
  });

  it('resolve posts: the selected code, status and note go to the human endpoint and the details reload', async () => {
    const { harness, posts } = await mount();
    await harness.navigateByUrl('/exec-tasks/T-001', ExecTasksPage);
    await settle(harness);
    choose(q<HTMLSelectElement>(el(harness), 'exec-resolve-code')!, 'OI-001');
    choose(q<HTMLSelectElement>(el(harness), 'exec-resolve-status')!, 'accepted');
    type(q<HTMLTextAreaElement>(el(harness), 'exec-resolve-note')!, 'accepted because the risk is small and documented');
    await settle(harness);
    q<HTMLButtonElement>(el(harness), 'exec-resolve-submit')!.click();
    await settle(harness);
    expect(posts).toEqual([['/api/v1/exec/items/OI-001/resolve', { status: 'accepted', note: 'accepted because the risk is small and documented' }]]);
    expect(TestBed.inject(UiToastService).toasts().some((t) => t.kind === 'ok')).toBe(true);
    expect(q<HTMLSelectElement>(el(harness), 'exec-resolve-code')!.value).toBe(''); // the form reset
  });
});

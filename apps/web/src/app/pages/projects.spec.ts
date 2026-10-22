// Projects page: edit form (PATCH), error toast, and restoring an archived project.
import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiClient } from '../api';
import { UiToastService } from '../ui/toast';
import { ProjectsPage } from './projects';

const ACTIVE = {
  id: 'p1', key: 'SSS', name: 'sss', status: 'active', description: 'old text', priority: 'low',
  start_date: '2026-10-01', target_date: null,
};
const ARCHIVED = { id: 'p2', key: 'OLD', name: 'old one', status: 'archived' };

interface Calls { patch: unknown[][]; post: unknown[][] }

async function mount(over: { patch?: ApiClient['patch'] } = {}) {
  const calls: Calls = { patch: [], post: [] };
  const api: Partial<ApiClient> = {
    get: async <T = unknown>(): Promise<T> => ({ items: [ACTIVE, ARCHIVED] }) as T,
    post: async <T = unknown>(...a: unknown[]): Promise<T> => (calls.post.push(a), {} as T),
    patch: over.patch ?? (async <T = unknown>(...a: unknown[]): Promise<T> => (calls.patch.push(a), {} as T)),
  };
  localStorage.removeItem('fpm_project');
  TestBed.configureTestingModule({ imports: [ProjectsPage], providers: [provideRouter([]), { provide: ApiClient, useValue: api }] });
  const f = TestBed.createComponent(ProjectsPage);
  f.detectChanges();
  await f.whenStable();
  f.detectChanges();
  return { f, el: f.nativeElement as HTMLElement, calls };
}

const q = <T extends HTMLElement>(el: HTMLElement, id: string): T => el.querySelector(`[data-testid="${id}"]`) as T;

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

describe('ProjectsPage', () => {
  it('edit form prefilled: Edit reveals name, description, priority and dates; the key is read-only', async () => {
    const { f, el } = await mount();
    expect(q(el, 'project-edit-form')).toBeNull();
    q<HTMLButtonElement>(el, 'project-edit').click();
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    expect(q<HTMLInputElement>(el, 'edit-name').value).toBe('sss');
    expect(q<HTMLTextAreaElement>(el, 'edit-description').value).toBe('old text');
    expect(q<HTMLSelectElement>(el, 'edit-priority').value).toBe('low');
    expect(q<HTMLInputElement>(el, 'edit-start').value).toBe('2026-10-01');
    expect(q<HTMLInputElement>(el, 'edit-key').readOnly).toBe(true);
  });

  it('edit saves patch: only changed fields are sent and a success toast shows', async () => {
    const { f, el, calls } = await mount();
    q<HTMLButtonElement>(el, 'project-edit').click();
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    type(q<HTMLInputElement>(el, 'edit-name'), 'renamed');
    f.detectChanges();
    q<HTMLButtonElement>(el, 'edit-save').click();
    await f.whenStable();
    expect(calls.patch).toEqual([['/api/v1/projects/p1', { name: 'renamed' }]]);
    expect(TestBed.inject(UiToastService).toasts().map((t) => t.kind)).toEqual(['ok']);
  });

  it('edit error toast: a failed save raises one error toast and keeps the form open', async () => {
    const { f, el } = await mount({ patch: async () => { throw new Error('boom'); } });
    q<HTMLButtonElement>(el, 'project-edit').click();
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    type(q<HTMLInputElement>(el, 'edit-name'), 'x');
    f.detectChanges();
    q<HTMLButtonElement>(el, 'edit-save').click();
    await f.whenStable();
    f.detectChanges();
    expect(TestBed.inject(UiToastService).toasts().map((t) => [t.kind, t.message])).toEqual([['error', 'boom']]);
    expect(q(el, 'project-edit-form')).not.toBeNull();
  });

  it('restore archived: the Restore button calls the unarchive endpoint', async () => {
    const { f, el, calls } = await mount();
    q<HTMLButtonElement>(el, 'project-restore').click();
    await f.whenStable();
    expect(calls.post).toEqual([['/api/v1/projects/p2/unarchive']]);
  });
});

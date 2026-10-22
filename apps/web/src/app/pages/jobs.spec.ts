// Jobs page: the jobs table with status badges and Retry for failed jobs.
import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ApiClient } from '../api';
import { JobsPage } from './jobs';

const JOBS = [
  { id: 'j1', type: 'github.process_delivery', status: 'failed', attempts: 3, error: 'boom', created_at: '2026-10-22T10:00:00Z' },
  { id: 'j2', type: 'system.ping', status: 'succeeded', attempts: 1, error: null, created_at: '2026-10-22T10:01:00Z' },
];

async function mount() {
  const posts: unknown[][] = [];
  const api: Partial<ApiClient> = {
    get: async <T = unknown>(): Promise<T> => ({ items: JOBS }) as T,
    post: async <T = unknown>(...a: unknown[]): Promise<T> => (posts.push(a), {} as T),
  };
  TestBed.configureTestingModule({ imports: [JobsPage], providers: [{ provide: ApiClient, useValue: api }] });
  const f = TestBed.createComponent(JobsPage);
  f.detectChanges();
  await f.whenStable();
  f.detectChanges();
  return { f, el: f.nativeElement as HTMLElement, posts };
}

describe('JobsPage', () => {
  it('jobs page: rows render with status badges and a count badge', async () => {
    const { el } = await mount();
    const rows = el.querySelectorAll('[data-testid="job-row"]');
    expect(rows.length).toBe(2);
    const badges = Array.from(el.querySelectorAll('[data-testid="job-status"] ui-badge')).map((b) => b.textContent?.trim());
    expect(badges).toEqual(['Failed', 'Succeeded']);
    expect(el.querySelector('[data-testid="job-status"] .ui-badge--error')).toBeTruthy();
    expect(el.querySelector('[data-testid="job-status"] .ui-badge--success')).toBeTruthy();
    expect(el.querySelector('.ui-card-head ui-badge')?.textContent?.trim()).toBe('2');
  });

  it('Retry shows only for failed jobs and posts to the retry endpoint', async () => {
    const { f, el, posts } = await mount();
    const retry = el.querySelectorAll<HTMLButtonElement>('[data-testid="job-retry"]');
    expect(retry.length).toBe(1);
    retry[0].click();
    await f.whenStable();
    expect(posts).toEqual([['/api/v1/jobs/j1/retry']]);
  });
});

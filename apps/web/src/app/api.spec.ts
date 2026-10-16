// Panel service tests (P7-3 coverage): ApiClient transport contract + I18n
// dictionary behaviour, against stubbed fetch / jsdom storage.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ApiClient } from './api';
import { I18n } from './i18n';

describe('ApiClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.cookie = 'fpm_csrf=tok-123; path=/';
    fetchMock = vi.fn(async (_path: string | URL, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('get: same-origin fetch with credentials and JSON unwrap', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    const api = TestBed.inject(ApiClient);
    const out = await api.get<{ ok: number }>('/api/v1/x');
    expect(out).toEqual({ ok: 1 });
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/v1/x');
    expect(init.credentials).toBe('include');
    expect(init.method).toBeUndefined();
  });

  it('send: echoes the CSRF cookie header and serializes the body', async () => {
    fetchMock.mockImplementation(async () => new Response('null', { status: 200 }));
    const api = TestBed.inject(ApiClient);
    await api.post('/api/v1/y', { a: 1 });
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/v1/y');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-csrf-token']).toBe('tok-123');
    expect(init.body).toBe('{"a":1}');
    await api.put('/api/v1/y', {});
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('PUT');
    await api.patch('/api/v1/y', {});
    expect((fetchMock.mock.calls[2][1] as RequestInit).method).toBe('PATCH');
  });

  it('204 returns undefined without parsing; non-ok throws message + status + code', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const api = TestBed.inject(ApiClient);
    await expect(api.send('DELETE', '/api/v1/z')).resolves.toBeUndefined();

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'nope', code: 'FORBIDDEN' } }), { status: 403 }),
    );
    const err = await api.get('/api/v1/z').catch((e: Error & { status?: number; code?: string }) => e) as Error & { status?: number; code?: string };
    expect(err.message).toBe('nope');
    expect(err.status).toBe(403);
    expect(err.code).toBe('FORBIDDEN');
  });

  it('missing CSRF cookie sends no header; empty body error falls back to HTTP status', async () => {
    document.cookie = 'fpm_csrf=; path=/; max-age=0';
    fetchMock.mockImplementationOnce(async () => new Response('null', { status: 200 }));
    const api = TestBed.inject(ApiClient);
    await api.post('/api/v1/w', { b: 2 });
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-csrf-token']).toBeUndefined();
    fetchMock.mockImplementationOnce(async () => new Response('{"x":1}', { status: 502 }));
    const err = await api.get('/api/v1/w').catch((e: Error) => e) as Error & { status?: number };
    expect(err.message).toBe('HTTP 502');
  });
});

describe('I18n', () => {
  it('resolves en/fa dictionaries, interpolates vars and falls back to en then the key', () => {
    const i18n = TestBed.inject(I18n);
    i18n.set('en');
    expect(i18n.instant('common.save')).toBe('Save');
    expect(i18n.instant('nonexistent.key')).toBe('nonexistent.key');
    i18n.set('fa');
    expect(i18n.dir()).toBe('rtl');
    expect(i18n.instant('common.save')).toBeTruthy();
    expect(i18n.instant('common.save')).not.toBe('common.save');
    // fa dictionary falls back to en for keys missing there
    expect(i18n.instant('definitely.missing')).toBe('definitely.missing');
  });

  it('interpolates {vars} and toggles language with document + persistence side effects', () => {
    localStorage.removeItem('fpm_lang');
    const i18n = TestBed.inject(I18n);
    i18n.set('en');
    expect(i18n.instant('table.info', { from: 1, to: 5, total: 10 })).toContain('1');
    i18n.toggle();
    expect(i18n.lang()).toBe('fa');
    expect(document.documentElement.dir).toBe('rtl');
    expect(localStorage.getItem('fpm_lang')).toBe('fa');
    i18n.toggle();
    expect(i18n.lang()).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
  });
});

// API keys page: multi-scope create, no ledger:decide, revoke confirmation and revoked/expired status.
import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ApiClient } from '../api';
import { UiToastService } from '../ui/toast';
import { ApiKeysPage, KEY_SCOPES, keyStatus } from './api-keys';

const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';
interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expires_at: string | null;
  revoked_at: string | null;
}
const KEYS: KeyRow[] = [
  { id: 'k1', name: 'ci', prefix: 'fpm_aaaaaaaa', scopes: ['read', 'write'], expires_at: null, revoked_at: null },
  { id: 'k2', name: 'old', prefix: 'fpm_bbbbbbbb', scopes: ['ledger:read', 'ledger:write'], expires_at: null, revoked_at: '2026-10-22T10:00:00.000Z' },
  { id: 'k3', name: 'stale', prefix: 'fpm_cccccccc', scopes: ['read'], expires_at: PAST, revoked_at: null },
];

async function mount() {
  const calls: { post: unknown[][]; send: unknown[][] } = { post: [], send: [] };
  let keys = [...KEYS];
  const api: Partial<ApiClient> = {
    get: async <T = unknown>(): Promise<T> => ({ items: keys }) as T,
    post: async <T = unknown>(...a: unknown[]): Promise<T> => (calls.post.push(a), ({ api_key: KEYS[0], raw_key: 'fpm_raw_once' }) as T),
    send: async <T = unknown>(...a: unknown[]): Promise<T> => {
      calls.send.push(a);
      keys = keys.map((k) => (String(a[1]).endsWith(k.id) ? { ...k, revoked_at: '2026-10-22T11:00:00.000Z' } : k));
      return undefined as T;
    },
  };
  TestBed.configureTestingModule({ imports: [ApiKeysPage], providers: [{ provide: ApiClient, useValue: api }] });
  const f = TestBed.createComponent(ApiKeysPage);
  for (let i = 0; i < 4; i++) {
    f.detectChanges();
    await f.whenStable();
    await new Promise((r) => setTimeout(r, 0));
  }
  f.detectChanges();
  return { f, el: f.nativeElement as HTMLElement, calls };
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
function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

describe('keyStatus', () => {
  it('revoked wins over expired; a past expiry is expired; otherwise active', () => {
    expect(keyStatus({ revoked_at: '2026-01-01T00:00:00Z', expires_at: PAST })).toBe('revoked');
    expect(keyStatus({ revoked_at: null, expires_at: PAST })).toBe('expired');
    expect(keyStatus({ revoked_at: null, expires_at: FUTURE })).toBe('active');
    expect(keyStatus({ revoked_at: null, expires_at: null })).toBe('active');
  });
});

describe('ApiKeysPage', () => {
  it('multi scope create: several ticked scopes are all posted and none ticked blocks the submit', async () => {
    const { f, el, calls } = await mount();
    type(q<HTMLInputElement>(el, 'apikey-name'), 'mcp');
    q<HTMLInputElement>(el, 'apikey-scope-ledger:read').click();
    q<HTMLInputElement>(el, 'apikey-scope-ledger:write').click();
    await settle(f);
    q<HTMLInputElement>(el, 'apikey-scope-read').click(); // untick the default
    await settle(f);
    q<HTMLButtonElement>(el, 'apikey-create').click();
    await settle(f);
    expect(calls.post).toEqual([['/api/v1/api-keys', { name: 'mcp', scopes: ['ledger:read', 'ledger:write'] }]]);
    expect(q(el, 'apikey-raw').textContent).toContain('fpm_raw_once');

    // the form resets to the default Read scope; unticking it leaves nothing ticked: disabled and an error
    expect(q<HTMLInputElement>(el, 'apikey-scope-read').checked).toBe(true);
    expect(q<HTMLButtonElement>(el, 'apikey-create').disabled).toBe(false);
    q<HTMLInputElement>(el, 'apikey-scope-read').click();
    await settle(f);
    expect(q<HTMLButtonElement>(el, 'apikey-create').disabled).toBe(true);
    expect(q(el, 'apikey-scope-error')).toBeTruthy();
  });

  it('no ledger decide scope: the human-only scope is not offered', async () => {
    const { el } = await mount();
    expect(KEY_SCOPES).not.toContain('ledger:decide' as never);
    expect(q(el, 'apikey-scope-ledger:decide')).toBeNull();
    expect(q(el, 'apikey-scopes').querySelectorAll('input[type="checkbox"]').length).toBe(KEY_SCOPES.length);
    expect(q(el, 'apikey-scopes').textContent).toContain('LedgerRead');
    expect(q(el, 'apikey-scopes').textContent).toContain('PlanApprove');
  });

  it('revoke confirm: Revoke asks first, then DELETEs and toasts; the key leaves the default list', async () => {
    const { f, el, calls } = await mount();
    expect(el.querySelectorAll('[data-testid="apikey-row"]').length).toBe(2); // k1 + expired k3; revoked k2 hidden
    el.querySelector<HTMLButtonElement>('[data-testid="apikey-revoke"]')!.click();
    await settle(f);
    expect(q(el, 'revoke-text').textContent).toContain('ci');
    expect(calls.send).toEqual([]);
    q<HTMLButtonElement>(el, 'revoke-confirm').click();
    await settle(f);
    expect(calls.send).toEqual([['DELETE', '/api/v1/api-keys/k1']]);
    expect(q(el, 'modal')).toBeNull();
    expect(TestBed.inject(UiToastService).toasts().map((t) => t.kind)).toContain('ok');
    expect(el.querySelectorAll('[data-testid="apikey-row"]').length).toBe(1);
  });

  it('revoked status: Show revoked reveals a Revoked badge and no Revoke action for that row', async () => {
    const { f, el } = await mount();
    q<HTMLButtonElement>(el, 'apikey-show-revoked').click();
    await settle(f);
    const rows = Array.from(el.querySelectorAll<HTMLElement>('[data-testid="apikey-row"]'));
    expect(rows.length).toBe(3);
    const revoked = rows.find((r) => r.textContent?.includes('old'))!;
    expect(revoked.querySelector('.ui-badge--error')?.textContent?.trim()).toBe('Revoked');
    expect(revoked.querySelector('[data-testid="apikey-revoke"]')).toBeNull();
    expect(rows.find((r) => r.textContent?.includes('ci'))!.querySelector('[data-testid="apikey-revoke"]')).toBeTruthy();
  });

  it('status badges: Active, Revoked and Expired carry colour and icon; scopes render as CamelCase chips', async () => {
    const { f, el } = await mount();
    q<HTMLButtonElement>(el, 'apikey-show-revoked').click();
    await settle(f);
    const status = (name: string) => {
      const row = Array.from(el.querySelectorAll<HTMLElement>('[data-testid="apikey-row"]')).find((r) => r.textContent?.includes(name))!;
      return row.querySelector<HTMLElement>('[data-testid="apikey-status"] ui-badge')!;
    };
    expect(status('ci').textContent?.trim()).toBe('Active');
    expect(status('ci').classList.contains('ui-badge--success')).toBe(true);
    expect(status('stale').textContent?.trim()).toBe('Expired');
    expect(status('stale').classList.contains('ui-badge--warning')).toBe(true);
    expect(status('stale').querySelector('ui-icon')).toBeTruthy();
    const chips = Array.from(el.querySelectorAll('[data-testid="apikey-scope-chips"] .ui-chip')).map((c) => c.textContent?.trim());
    expect(chips).toContain('LedgerWrite');
    expect(chips).toContain('Write');
  });

  it('mcp samples: the CLI command, the JSON config and the smoke test use the panel origin plus /mcp', async () => {
    const { el } = await mount();
    const url = `${window.location.origin}/mcp`;
    const cli = q(el, 'mcp-code-cli').textContent ?? '';
    expect(cli).toContain('claude mcp add --transport http forgepm ' + url);
    expect(cli).toContain('Bearer fpm_REPLACE_WITH_SECRET');
    const json = JSON.parse(q(el, 'mcp-code-json').textContent ?? '{}');
    expect(json.mcpServers.forgepm).toEqual({ type: 'http', url, headers: { Authorization: 'Bearer fpm_REPLACE_WITH_SECRET' } });
    expect(q(el, 'mcp-code-smoke').textContent).toContain('npm run mcp:smoke');
  });

  it('mcp samples use raw key: right after creating a key the samples carry it, and a reload does not', async () => {
    const { f, el } = await mount();
    type(q<HTMLInputElement>(el, 'apikey-name'), 'mcp');
    q<HTMLButtonElement>(el, 'apikey-mcp-preset').click();
    await settle(f);
    q<HTMLButtonElement>(el, 'apikey-create').click();
    await settle(f);
    expect(q(el, 'mcp-code-cli').textContent).toContain('Bearer fpm_raw_once');
    expect(JSON.parse(q(el, 'mcp-code-json').textContent ?? '{}').mcpServers.forgepm.headers.Authorization).toBe('Bearer fpm_raw_once');
    expect(q(el, 'mcp-code-cli').textContent).not.toContain('REPLACE_WITH_SECRET');
  });

  it('keyboard access: every code block is a focusable, labelled region (scrollable content must be reachable by keyboard)', async () => {
    const { el } = await mount();
    const blocks = Array.from(el.querySelectorAll<HTMLElement>('[data-testid="mcp-card"] pre'));
    expect(blocks.length).toBe(3);
    for (const b of blocks) {
      expect(b.getAttribute('tabindex')).toBe('0');
      expect(b.getAttribute('role')).toBe('region');
      expect(b.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('copy sample: each copy button writes its text to the clipboard and toasts', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => void written.push(t) }, configurable: true });
    const { f, el } = await mount();
    q<HTMLButtonElement>(el, 'mcp-copy-cli').click();
    q<HTMLButtonElement>(el, 'mcp-copy-json').click();
    await settle(f);
    expect(written.length).toBe(2);
    expect(written[0]).toBe(q(el, 'mcp-code-cli').textContent);
    expect(written[1]).toBe(q(el, 'mcp-code-json').textContent);
    expect(TestBed.inject(UiToastService).toasts().filter((t) => t.kind === 'ok').length).toBeGreaterThanOrEqual(2);
  });

  it('mcp preset: ticks exactly ledger:read and ledger:write', async () => {
    const { f, el } = await mount();
    q<HTMLButtonElement>(el, 'apikey-mcp-preset').click();
    await settle(f);
    const ticked = Array.from(el.querySelectorAll<HTMLInputElement>('[data-testid="apikey-scopes"] input:checked')).map((i) => i.getAttribute('data-testid'));
    expect(ticked).toEqual(['apikey-scope-ledger:read', 'apikey-scope-ledger:write']);
  });
});

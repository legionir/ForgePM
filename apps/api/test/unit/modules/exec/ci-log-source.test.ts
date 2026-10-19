import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { readCiLog } from '../../../../src/modules/exec/ci-log-source';

const SHA = 'a'.repeat(40);

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('readCiLog', () => {
  it('requests the measured SHA with the encrypted-store token and verifies the response SHA', async () => {
    const log = '✓ auth > logs in\n1 passed';
    const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(String(input));
      expect(url.pathname).toContain(SHA);
      expect(init?.headers).toMatchObject({ authorization: 'Bearer secret-value' });
      expect(init?.redirect).toBe('error');
      return response({ sha: SHA.toUpperCase(), run_id: 'run-17', job: 'unit', provider: 'generic', log });
    });
    const result = await readCiLog({
      endpoint: 'https://ci.example.test/logs/{sha}',
      sha: SHA,
      secret: 'secret-value',
      fetcher,
      privateHostGuard: async () => false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.sha).toBe(SHA);
      expect(result.snapshot.sha256_log).toBe(createHash('sha256').update(log).digest('hex'));
      expect(result.snapshot.run_id).toBe('run-17');
    }
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('fails closed when the endpoint returns a log for a different commit', async () => {
    const fetcher = vi.fn(async () => response({ sha: 'b'.repeat(40), run_id: 'run-18', job: 'unit', log: '1 passed' }));
    const result = await readCiLog({
      endpoint: 'https://ci.example.test/logs',
      sha: SHA,
      secret: 'secret-value',
      fetcher: fetcher as typeof fetch,
      privateHostGuard: async () => false,
    });
    expect(result).toEqual({ ok: false, reason: 'CI log SHA does not match the requested commit SHA' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('blocks private targets before issuing a request and rejects non-HTTPS endpoints', async () => {
    const fetcher = vi.fn();
    const blocked = await readCiLog({
      endpoint: 'https://127.0.0.1/logs/{sha}',
      sha: SHA,
      secret: 'secret-value',
      fetcher: fetcher as typeof fetch,
      privateHostGuard: async () => true,
    });
    expect(blocked.ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();

    const insecure = await readCiLog({
      endpoint: 'http://ci.example.test/logs/{sha}',
      sha: SHA,
      secret: 'secret-value',
      fetcher: fetcher as typeof fetch,
      privateHostGuard: async () => false,
    });
    expect(insecure).toEqual({ ok: false, reason: 'CI endpoint must be HTTPS without userinfo or a fragment' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects header-injection characters in the secret without issuing a request', async () => {
    const fetcher = vi.fn();
    const result = await readCiLog({
      endpoint: 'https://ci.example.test/logs/{sha}',
      sha: SHA,
      secret: 'token\r\nX-Injected: yes',
      fetcher: fetcher as typeof fetch,
      privateHostGuard: async () => false,
    });
    expect(result).toEqual({ ok: false, reason: 'CI log secret contains invalid header characters' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses an oversized response without persisting its contents', async () => {
    const fetcher = vi.fn(async () => new Response('x'.repeat(1_048_577), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const result = await readCiLog({
      endpoint: 'https://ci.example.test/logs/{sha}',
      sha: SHA,
      secret: 'secret-value',
      fetcher: fetcher as typeof fetch,
      privateHostGuard: async () => false,
    });
    expect(result).toEqual({ ok: false, reason: 'CI log response exceeded the safe size limit or could not be read' });
  });

  it('R-04: prod build rejects 8.8.8.8 host (not in allowlist, must be injected via config)', async () => {
    const fetcher = vi.fn();
    const result = await readCiLog({
      endpoint: 'https://8.8.8.8/logs/{sha}',
      sha: SHA,
      secret: 'secret-value',
      fetcher: fetcher as typeof fetch,
      privateHostGuard: async () => false,
    });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/not in allowlist/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('R-04: rejects envelope with failing conclusion and non-allowlisted workflow', async () => {
    const failFetcher = vi.fn(async () => response({ sha: SHA, run_id: 'run-1', job: 'unit', log: 'x', conclusion: 'failure' }));
    const failRes = await readCiLog({
      endpoint: 'https://ci.example.test/logs/{sha}',
      sha: SHA,
      secret: 's',
      fetcher: failFetcher as typeof fetch,
      privateHostGuard: async () => false,
    });
    expect(failRes).toEqual({ ok: false, reason: "CI run conclusion 'failure' is not successful" });

    const wfFetcher = vi.fn(async () => response({ sha: SHA, run_id: 'run-1', job: 'unit', log: 'x', workflow: 'evil' }));
    const wfRes = await readCiLog({
      endpoint: 'https://ci.example.test/logs/{sha}',
      sha: SHA,
      secret: 's',
      fetcher: wfFetcher as typeof fetch,
      privateHostGuard: async () => false,
    });
    expect(wfRes).toEqual({ ok: false, reason: "CI workflow 'evil' not in allowlist" });
  });
});

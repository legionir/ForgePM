import { promises as dns } from 'node:dns';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isBlockedPrivateHostAll } from '../../src/app/ssrf';

afterEach(() => vi.restoreAllMocks());

describe('SSRF target guard', () => {
  it('blocks loopback, private, link-local, mapped IPv4 and reserved address literals', async () => {
    for (const url of [
      'https://127.0.0.1/logs',
      'https://10.0.0.2/logs',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/logs',
      'https://[::ffff:7f00:1]/logs',
      'https://0.1.2.3/logs',
    ]) {
      expect(await isBlockedPrivateHostAll(url), url).toBe(true);
    }
  });

  it('checks every DNS result and fails closed when resolution fails', async () => {
    const lookup = vi.spyOn(dns, 'lookup');
    lookup.mockResolvedValueOnce([{ address: 'fd00::42', family: 6 }]);
    expect(await isBlockedPrivateHostAll('https://ci.example.test/logs')).toBe(true);
    lookup.mockRejectedValueOnce(new Error('DNS unavailable'));
    expect(await isBlockedPrivateHostAll('https://ci.example.test/logs')).toBe(true);
  });

  it('allows a public literal and only allows private targets with explicit opt-in', async () => {
    expect(await isBlockedPrivateHostAll('https://8.8.8.8/logs')).toBe(false);
    expect(await isBlockedPrivateHostAll('https://127.0.0.1/logs', true)).toBe(false);
  });
});

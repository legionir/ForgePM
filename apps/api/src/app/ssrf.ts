import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

/**
 * SSRF guard (plan §14): block private / link-local / loopback targets for
 * provider base_url and external MCP servers. `allowPrivate` opts the caller
 * in when the admin set network.allow_private_targets.
 */
const PRIVATE_V4 = [
  [10, 0, 0, 0, 10, 255, 255, 255],
  [172, 16, 0, 0, 172, 31, 255, 255],
  [192, 168, 0, 0, 192, 168, 255, 255],
  [169, 254, 0, 0, 169, 254, 255, 255],
  [127, 0, 0, 0, 127, 255, 255, 255],
] as const;

function inRanges(ip: string): boolean {
  if (!isIP(ip)) return false;
  const o = ip.split('.').map(Number);
  if (o.length !== 4) return ip.startsWith('::1') || ip.toLowerCase().startsWith('fe80'); // v6 loopback/link-local
  for (const r of PRIVATE_V4) {
    if (o[0] >= r[0] && o[0] <= r[4] && o[1] >= r[1] && o[1] <= r[5] && o[2] >= r[2] && o[2] <= r[6] && o[3] >= r[3] && o[3] <= r[7]) {
      return true;
    }
  }
  return false;
}

/** Returns true when the URL must be BLOCKED (private/link-local, or literal localhost). */
export async function isBlockedPrivateHost(url: string, allowPrivate = false): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false; // malformed -> caught by zod
  }
  const host = parsed.hostname;
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return !allowPrivate;
  }
  if (isIP(host)) return inRanges(host) && !allowPrivate;
  try {
    const recs = await dns.lookup(host, { all: true });
    return recs.some((r) => inRanges(r.address)) && !allowPrivate;
  } catch {
    return false;
  }
}

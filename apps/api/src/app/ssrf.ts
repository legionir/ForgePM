import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

/**
 * SSRF guard (plan §14): block private / link-local / loopback targets for
 * provider base_url and external MCP servers. `allowPrivate` opts the caller
 * in when the admin set network.allow_private_targets.
 */
const PRIVATE_V4 = [
  [0, 0, 0, 0, 0, 255, 255, 255],
  [10, 0, 0, 0, 10, 255, 255, 255],
  [100, 64, 0, 0, 100, 127, 255, 255],
  [127, 0, 0, 0, 127, 255, 255, 255],
  [169, 254, 0, 0, 169, 254, 255, 255],
  [172, 16, 0, 0, 172, 31, 255, 255],
  [192, 0, 0, 0, 192, 0, 0, 255],
  [192, 0, 2, 0, 192, 0, 2, 255],
  [192, 168, 0, 0, 192, 168, 255, 255],
  [198, 18, 0, 0, 198, 19, 255, 255],
  [198, 51, 100, 0, 198, 51, 100, 255],
  [203, 0, 113, 0, 203, 0, 113, 255],
  [224, 0, 0, 0, 255, 255, 255, 255],
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

  // Block any http:// URL — only HTTPS is allowed for external providers/MCP servers.
  if (parsed.protocol.startsWith('http:')) {
    return !allowPrivate;
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return !allowPrivate;
  }
  if (isIP(host)) return (isIP(host) === 4 ? inRanges(host) : isIPv6Private(host)) && !allowPrivate;
  try {
    const recs = await dns.lookup(host, { all: true });
    return recs.some((r) => inRanges(r.address) || isIPv6Private(r.address)) && !allowPrivate;
  } catch {
    return false;
  }
}

/** True when the IP address is IPv6 private, loopback, link-local, or multicast. */
function isIPv6Private(ip: string): boolean {
  const low = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (low === '::' || low === '::1') return true;
  const first = Number.parseInt(low.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((first & 0xff00) === 0xff00) return true; // multicast ff00::/8
  if ((first & 0xffc0) === 0xfec0) return true; // deprecated site-local fec0::/10

  // IPv4-mapped IPv6 literals must inherit the IPv4 policy.
  const mapped = low.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped?.[1]) return inRanges(mapped[1]);
  if (low.startsWith('::ffff:')) {
    const tail = low.slice('::ffff:'.length).split(':');
    if (tail.length === 1 && /^[0-9a-f]{1,8}$/.test(tail[0] ?? '')) {
      const n = Number.parseInt(tail[0] ?? '0', 16);
      return inRanges(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
    }
    if (tail.length === 2 && tail.every((part) => /^[0-9a-f]{1,4}$/.test(part))) {
      const n = ((Number.parseInt(tail[0] ?? '0', 16) << 16) | Number.parseInt(tail[1] ?? '0', 16)) >>> 0;
      return inRanges(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
    }
  }
  return false;
}

/** Extend DNS results check to also reject IPv6 private addresses. */
export async function isBlockedPrivateHostAll(url: string, allowPrivate = false): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    const blocked = isIP(host) === 4 ? inRanges(host) : isIPv6Private(host);
    return blocked && !allowPrivate;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return !allowPrivate;
  }
  try {
    const recs = await dns.lookup(host, { all: true });
    return recs.some((r) => inRanges(r.address) || isIPv6Private(r.address)) && !allowPrivate;
  } catch {
    return !allowPrivate;
  }
}

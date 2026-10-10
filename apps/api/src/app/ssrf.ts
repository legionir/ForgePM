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

  // Block any http:// URL — only HTTPS is allowed for external providers/MCP servers.
  if (parsed.protocol.startsWith('http:')) {
    return !allowPrivate;
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

/** True when the IP address is IPv6 private, loopback, link-local, or multicast. */
function isIPv6Private(ip: string): boolean {
  const low = ip.toLowerCase();
  // ::1 / loopback
  if (low === '::1') return true;
  // Link-local fe80::/10
  if (low.startsWith('fe80')) return true;
  // Unique local addresses fc00::/7 (ULA)
  if (low.startsWith('fc') || low.startsWith('fd')) return true;
  // Multicast ff00::/8
  if (low.startsWith('ff')) return true;
  // Site-local (deprecated, but still block)
  if (low.startsWith('fec0')) return true;
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
  const host = parsed.hostname;
  if (isIP(host)) {
    const blocked = inRanges(host) || isIPv6Private(host);
    return blocked && !allowPrivate;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return !allowPrivate;
  }
  try {
    const recs = await dns.lookup(host, { all: true });
    return recs.some((r) => inRanges(r.address) || isIPv6Private(r.address)) && !allowPrivate;
  } catch {
    return false;
  }
}

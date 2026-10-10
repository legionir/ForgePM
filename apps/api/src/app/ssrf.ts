import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export const ALLOWED_SCHEMES = new Set(['https:', 'git+https:']);
const PROHIBITED_SCHEMES = new Set(['http:', 'ftp:', 'file:', 'gopher:']);

// Ranges from RFC 1918 / RFC 4193 / RFC 4291 / RFC 5128
const PRIVATE_PREFIXES = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fc00::/7',
  'fe80::/10',
];

export function inRanges(addr: string): boolean {
  try {
    const parsed = ipaddr.parse(addr);
    if (parsed.kind() === 'ipv6') return false;
    const ipv4 = parsed as ipaddr.IPv4;
    return (
      ipv4.isPrivate() ||
      ipv4.isLoopback() ||
      ipv4.isLinkLocal() ||
      ipv4.isMulticast()
    );
  } catch {
    return false;
  }
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
    const recs = await dnsLookup(host, { all: true });
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
    const recs = await dnsLookup(host, { all: true });
    return recs.some((r) => inRanges(r.address) || isIPv6Private(r.address)) && !allowPrivate;
  } catch {
    return false;
  }
}

export async function assertUrlSafe(
  url: string,
  opts?: { allowPrivate?: boolean; allowHttp?: boolean },
): Promise<void> {
  if (!url || typeof url !== 'string') return;

  const u = new URL(url);

  // 1. Protocol whitelist
  if (u.protocol === 'http:' && !opts?.allowHttp) {
    throw new Error('HTTP URLs are blocked; use HTTPS for external providers/MCP servers');
  }
  if (!ALLOWED_SCHEMES.has(u.protocol) && !opts?.allowHttp) {
    throw new Error(`Forbidden URL scheme: ${u.protocol}`);
  }

  // 2. Host blocking — IP literals AND resolved DNS names
  const host = u.hostname;
  const blocked = await isBlockedPrivateHostAll(url, opts?.allowPrivate);
  if (blocked) {
    throw new Error('Forbidden host (private/reserved/loopback): ' + host);
  }
}

/**
 * Trusted proxy configuration (POU-18).
 *
 * Only addresses from this list may set the client IP via
 * X-Forwarded-For / X-Real-IP. Direct requests always use the real
 * connection socket address; forged headers are ignored.
 */

export const TRUSTED_PROXIES: string[] =
  process.env.TRUSTED_PROXY_IPS?.split(',').map(s => s.trim()).filter(Boolean) ?? [];

export function isTrustedProxy(ip: string): boolean {
  if (!ip) return false;
  // When no explicit list is configured fall back to common RFC1918 ranges
  // so local dev / k8s ingress still works.
  if (TRUSTED_PROXIES.length === 0) {
    return ip.startsWith('10.') || ip.startsWith('172.16.') || ip.startsWith('172.17.') || ip.startsWith('172.18.') || ip.startsWith('172.19.') || ip.startsWith('172.20.') || ip.startsWith('172.21.') || ip.startsWith('172.22.') || ip.startsWith('172.23.') || ip.startsWith('172.24.') || ip.startsWith('172.25.') || ip.startsWith('172.26.') || ip.startsWith('172.27.') || ip.startsWith('172.28.') || ip.startsWith('172.29.') || ip.startsWith('172.30.') || ip.startsWith('172.31.') || ip.startsWith('192.168.') || ip === '::1' || ip === '::ffff:10.0.0.0' || ip === '::ffff:172.16.0.0' || ip === '::ffff:192.168.0.0';
  }
  return TRUSTED_PROXIES.includes(ip);
}

/**
 * Read the *real* client IP from request headers when the requester is a
 * trusted proxy. Returns the socket remoteAddress otherwise. Forged headers
 * are never honoured for untrusted sources.
 */
export function resolveClientIp(req: { ip: string; headers: { [key: string]: string | undefined }; socket: { remoteAddress?: string } }): string {
  const socketIp = req.socket?.remoteAddress ?? req.ip;
  const forwarded = req.headers['x-forwarded-for'];
  const realIp = req.headers['x-real-ip'];
  if (isTrustedProxy(socketIp)) {
    if (realIp) return realIp;
    if (forwarded) {
      // x-forwarded-for: client, proxy1, proxy2 — take the leftmost
      const first = forwarded.split(',').map(s => s.trim()).filter(Boolean)[0];
      if (first) return first;
    }
  }
  return socketIp;
}

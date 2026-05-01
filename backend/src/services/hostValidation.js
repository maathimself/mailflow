import { isIPv4, isIPv6 } from 'net';
import { promises as dnsPromises } from 'dns';

function ipv4ToLong(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inCidr(ip, base, bits) {
  const mask = bits === 0 ? 0 : ((~0 << (32 - bits)) >>> 0);
  return (ipv4ToLong(ip) & mask) === (ipv4ToLong(base) & mask);
}

function isPrivateIPv4(ip) {
  return (
    inCidr(ip, '0.0.0.0', 8)      ||  // 0.x.x.x
    inCidr(ip, '10.0.0.0', 8)     ||  // private
    inCidr(ip, '100.64.0.0', 10)  ||  // CGNAT shared
    inCidr(ip, '127.0.0.0', 8)    ||  // loopback
    inCidr(ip, '169.254.0.0', 16) ||  // link-local (AWS metadata)
    inCidr(ip, '172.16.0.0', 12)  ||  // private
    inCidr(ip, '192.0.0.0', 24)   ||  // IETF protocol assignments
    inCidr(ip, '192.168.0.0', 16) ||  // private
    inCidr(ip, '198.18.0.0', 15)  ||  // benchmarking
    inCidr(ip, '240.0.0.0', 4)    ||  // reserved
    ip === '255.255.255.255'
  );
}

function isPrivateIPv6(ip) {
  const h = ip.toLowerCase();
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  // IPv4-mapped IPv6 (::ffff:x.x.x.x) — check the embedded IPv4 address.
  // Without this, ::ffff:127.0.0.1 bypasses the IPv4 private-range checks.
  if (h.startsWith('::ffff:')) {
    const embedded = h.slice(7);
    if (isIPv4(embedded)) return isPrivateIPv4(embedded);
  }
  return false;
}

// Synchronous check: literal IPs and reserved hostnames.
export function validateHostLiteral(host) {
  if (!host || typeof host !== 'string') return null;
  const h = host.trim().toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost') || h.endsWith('.internal')) {
    return 'Host cannot be a local address';
  }
  const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  if (isIPv4(bare) && isPrivateIPv4(bare)) return 'Host cannot be a private or reserved IP address';
  if (isIPv6(bare) && isPrivateIPv6(bare)) return 'Host cannot be a private or reserved IP address';
  return null;
}

// Async check: resolve A/AAAA records and reject any that are private/reserved.
// Prevents SSRF via controlled hostnames that resolve to internal addresses.
export async function validateHost(host) {
  const literalErr = validateHostLiteral(host);
  if (literalErr) return literalErr;

  const h = host.trim().toLowerCase();
  const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;

  // Already a literal IP — validated above.
  if (isIPv4(bare) || isIPv6(bare)) return null;

  // Resolve A and AAAA records. Ignore DNS errors — if the host can't be resolved,
  // the IMAP/SMTP connection will fail naturally; the concern is hosts that DO resolve
  // to private ranges.
  const [v4, v6] = await Promise.all([
    dnsPromises.resolve4(bare).catch(() => []),
    dnsPromises.resolve6(bare).catch(() => []),
  ]);

  for (const addr of [...v4, ...v6]) {
    if (isIPv4(addr) && isPrivateIPv4(addr)) return 'Host resolves to a private or reserved IP address';
    if (isIPv6(addr) && isPrivateIPv6(addr)) return 'Host resolves to a private or reserved IP address';
  }

  return null;
}

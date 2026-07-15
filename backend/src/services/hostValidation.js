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

function ipv6ToBigInt(ip) {
  let normalized = ip.toLowerCase();
  const lastWord = normalized.slice(normalized.lastIndexOf(':') + 1);
  if (isIPv4(lastWord)) {
    const value = ipv4ToLong(lastWord);
    normalized = `${normalized.slice(0, normalized.lastIndexOf(':') + 1)}`
      + `${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 && missing < 1) return null;
  const words = halves.length === 2
    ? [...left, ...Array(missing).fill('0'), ...right]
    : left;
  if (words.length !== 8 || words.some(word => !/^[0-9a-f]{1,4}$/.test(word))) return null;

  return words.reduce((value, word) => (value << 16n) | BigInt(`0x${word}`), 0n);
}

function inIPv6Cidr(ip, base, bits) {
  const shift = 128n - BigInt(bits);
  return (ip >> shift) === (base >> shift);
}

const ipv4MappedPrefix = ipv6ToBigInt('::ffff:0:0');
const privateIPv6Cidrs = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],       // Teredo
  ['2001:db8::', 32],   // documentation
  ['2001:10::', 28],    // ORCHID
  ['2002::', 16],       // 6to4
  ['fc00::', 7],        // unique-local
  ['fe80::', 10],       // link-local
  ['ff00::', 8],        // multicast
].map(([base, bits]) => [ipv6ToBigInt(base), bits]);

function isPrivateIPv6(ip) {
  const value = ipv6ToBigInt(ip);
  if (value == null) return false;
  if (inIPv6Cidr(value, ipv4MappedPrefix, 96)) {
    const embedded = Number(value & 0xffffffffn);
    const ipv4 = `${embedded >>> 24}.${(embedded >>> 16) & 0xff}`
      + `.${(embedded >>> 8) & 0xff}.${embedded & 0xff}`;
    return isPrivateIPv4(ipv4);
  }
  return privateIPv6Cidrs.some(([base, bits]) => inIPv6Cidr(value, base, bits));
}

// Synchronous check: literal IPs and reserved hostnames.
export function validateHostLiteral(host, { allowPrivate = false } = {}) {
  if (!host || typeof host !== 'string') return null;
  if (allowPrivate) return null;
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
export async function validateHost(host, { allowPrivate = false } = {}) {
  const literalErr = validateHostLiteral(host, { allowPrivate });
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

  if (!allowPrivate) {
    for (const addr of [...v4, ...v6]) {
      if (isIPv4(addr) && isPrivateIPv4(addr)) return 'Host resolves to a private or reserved IP address';
      if (isIPv6(addr) && isPrivateIPv6(addr)) return 'Host resolves to a private or reserved IP address';
    }
  }

  return null;
}

// Resolves a hostname to a specific public IP for use as the actual connection target,
// closing the DNS rebinding TOCTOU window between validateHost() and the real connect.
//
// Returns { host, servername } where:
//   host       — the IP to connect to (or original value if already literal / unresolvable)
//   servername — original hostname for TLS SNI and cert verification (null if host was
//                already a literal IP, since SNI override is not needed in that case)
//
// Throws if the host is a reserved/private literal or if DNS resolves to a private range.
// Pass { allowPrivate: true } to skip all private/local checks (for self-hosted servers).
export async function resolveForConnection(hostname, { allowPrivate = false } = {}) {
  const literalErr = validateHostLiteral(hostname, { allowPrivate });
  if (literalErr) throw new Error(literalErr);

  const h = hostname.trim();
  const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h.toLowerCase();

  // Already a literal IP — validated above, no DNS resolution needed.
  if (isIPv4(bare) || isIPv6(bare)) return { host: h, servername: null };

  const [v4, v6] = await Promise.all([
    dnsPromises.resolve4(bare).catch(() => []),
    dnsPromises.resolve6(bare).catch(() => []),
  ]);

  if (!allowPrivate) {
    for (const addr of [...v4, ...v6]) {
      if (isIPv4(addr) && isPrivateIPv4(addr)) throw new Error('Host resolves to a private or reserved IP address');
      if (isIPv6(addr) && isPrivateIPv6(addr)) throw new Error('Host resolves to a private or reserved IP address');
    }
  }

  const all = [...v4, ...v6];
  // DNS failed — let the connection attempt fail naturally (NXDOMAIN etc.).
  if (!all.length) return { host: h, servername: null };

  // Pin to first validated IP. Pass servername so TLS SNI and cert verification
  // still use the hostname even though the socket connects directly to the IP.
  return { host: all[0], servername: h };
}

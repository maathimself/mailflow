import { isIPv4, isIPv6 } from 'net';
import { promises as dnsPromises } from 'dns';
import { domainToASCII } from 'url';

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

// One address has many spellings (::1, 0:0:0:0:0:0:0:1, ::1%lo, or ::ffff:7f00:1 for
// ::ffff:127.0.0.1), so classify its eight 16-bit groups rather than its text.
function ipv6Groups(ip) {
  let h = ip.split('%')[0];
  const tail = h.slice(h.lastIndexOf(':') + 1);
  if (isIPv4(tail)) {
    const n = ipv4ToLong(tail);
    h = `${h.slice(0, -tail.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, rest] = h.split('::');
  const groups = s => (s ? s.split(':').map(g => parseInt(g, 16)) : []);
  if (rest === undefined) return groups(head);
  const hi = groups(head);
  const lo = groups(rest);
  return [...hi, ...new Array(8 - hi.length - lo.length).fill(0), ...lo];
}

function isPrivateIPv6(ip) {
  const g = ipv6Groups(ip);
  const zero = (from, to) => g.slice(from, to).every(x => x === 0);
  const embedded = i => `${g[i] >> 8}.${g[i] & 0xff}.${g[i + 1] >> 8}.${g[i + 1] & 0xff}`;
  // ::/96 holds :: (which connects to loopback), ::1 and the IPv4-compatible ::x.x.x.x.
  if (zero(0, 6)) return true;
  if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80) return true; // fc00::/7, fe80::/10
  // IPv4-mapped IPv6 (::ffff:x.x.x.x) and NAT64 (64:ff9b::x.x.x.x) — check the embedded IPv4.
  // Without this, ::ffff:127.0.0.1 bypasses the IPv4 private-range checks.
  if (zero(0, 5) && g[5] === 0xffff) return isPrivateIPv4(embedded(6));
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return isPrivateIPv4(embedded(6));
  // 6to4 (2002::/16) — embeds an IPv4 address in bits 16-47.
  // e.g. 2002:7f00:0001:: wraps 127.0.0.1 and bypasses IPv4 checks without this guard.
  if (g[0] === 0x2002 && isPrivateIPv4(embedded(1))) return true;
  // Teredo (2001:0000::/32) — reject the entire prefix; Teredo tunnels UDP through NAT
  // and can reach private ranges via the embedded server/client address fields.
  if (g[0] === 0x2001 && g[1] === 0) return true;
  return false;
}

// getaddrinfo (glibc, musl) reads 2130706433, 0x7f000001, 0177.0.0.1 and 127.1 as IPv4
// addresses, but net.isIPv4 accepts only the dotted quad. The URL parser reads the same
// inet_aton forms, so use it to find the address the socket would connect to.
function inetAtonIPv4(host) {
  if (!/^[0-9a-fx.]+$/.test(host)) return null;
  try {
    const { hostname } = new URL(`http://${host}/`);
    return isIPv4(hostname) ? hostname : null;
  } catch {
    return null;
  }
}

// Synchronous check: literal IPs and reserved hostnames.
export function validateHostLiteral(host, { allowPrivate = false } = {}) {
  if (!host || typeof host !== 'string') return null;
  if (allowPrivate) return null;
  let h = host.trim();
  // dns.lookup converts a non-ASCII host to ASCII before getaddrinfo reads it, so
  // １２７.０.０.１ reaches 127.0.0.1 and ::１ reaches ::1. Check the converted form, and
  // refuse a host that domainToASCII rejects, as it does every Unicode spelling of IPv6.
  if (/[^\p{ASCII}]/u.test(h)) {
    h = domainToASCII(h);
    if (!h) return 'Host is not a valid hostname';
  }
  h = h.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost') || h.endsWith('.internal')) {
    return 'Host cannot be a local address';
  }
  const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  const v4 = isIPv4(bare) ? bare : inetAtonIPv4(bare);
  if (v4 && isPrivateIPv4(v4)) return 'Host cannot be a private or reserved IP address';
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

export function createPinnedLookup(addresses) {
  const candidates = addresses.map(address => ({
    address,
    family: isIPv4(address) ? 4 : 6,
  }));

  return (_hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    // Always answer asynchronously, like dns.lookup(). Node connects from inside this
    // callback, so a synchronous answer whose every address fails synchronously (e.g.
    // ENETUNREACH for IPv6-only candidates in a container without IPv6) destroys the socket
    // before tls.connect() returns: it throws on setServername(), the caller never attaches
    // its 'error' listener, and the socket's AggregateError then crashes the process.
    const family = Number(options?.family) || 0;
    const eligible = family ? candidates.filter(candidate => candidate.family === family) : candidates;
    if (!eligible.length) {
      const err = new Error('No validated address matches the requested family');
      err.code = 'ENOTFOUND';
      return process.nextTick(callback, err);
    }
    if (options?.all) return process.nextTick(callback, null, eligible.map(candidate => ({ ...candidate })));
    process.nextTick(callback, null, eligible[0].address, eligible[0].family);
  };
}

// Resolves a hostname to public IPs for use as the only permitted connection targets,
// closing the DNS rebinding TOCTOU window between validation and the real connect.
//
// `host` remains the first IP for callers that cannot use multi-address fallback. `lookup`
// exposes the complete validated set without performing DNS again, while `servername`
// preserves the original hostname for TLS SNI and certificate verification.
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

  const all = [...new Set([...v4, ...v6])];
  // DNS failed — let the connection attempt fail naturally (NXDOMAIN etc.).
  if (!all.length) return { host: h, servername: null };

  // Expose only prevalidated addresses to the connection layer. No later DNS query can
  // substitute an unvalidated target, and TLS still authenticates the original hostname.
  return {
    host: all[0],
    servername: h,
    addresses: all,
    lookup: createPinnedLookup(all),
  };
}

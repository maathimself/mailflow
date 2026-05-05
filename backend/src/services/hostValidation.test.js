import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateHostLiteral, validateHost, resolveForConnection } from './hostValidation.js';

// Mock the dns module so tests never make real network calls.
vi.mock('dns', () => ({
  promises: {
    resolve4: vi.fn().mockResolvedValue([]),
    resolve6: vi.fn().mockResolvedValue([]),
  },
}));

// Pull the mocked fns for per-test control.
const { promises: dns } = await import('dns');

beforeEach(() => {
  dns.resolve4.mockClear();
  dns.resolve6.mockClear();
  dns.resolve4.mockResolvedValue([]);
  dns.resolve6.mockResolvedValue([]);
});

// ── validateHostLiteral ────────────────────────────────────────────────────

describe('validateHostLiteral', () => {
  it('passes a valid public hostname', () => {
    expect(validateHostLiteral('imap.gmail.com')).toBeNull();
  });

  it('passes a valid public IPv4', () => {
    expect(validateHostLiteral('8.8.8.8')).toBeNull();
  });

  it('passes a valid public IPv6', () => {
    expect(validateHostLiteral('2001:db8::1')).toBeNull();
  });

  it('returns null for null/undefined/empty', () => {
    expect(validateHostLiteral(null)).toBeNull();
    expect(validateHostLiteral(undefined)).toBeNull();
    expect(validateHostLiteral('')).toBeNull();
  });

  // Reserved hostnames
  it.each([
    ['localhost'],
    ['mail.local'],
    ['server.internal'],
    ['host.localhost'],
  ])('blocks reserved hostname %s', host => {
    expect(validateHostLiteral(host)).toMatch(/local/i);
  });

  // Private IPv4 ranges
  it.each([
    ['10.0.0.1'],
    ['10.255.255.255'],
    ['172.16.0.1'],
    ['172.31.255.255'],
    ['192.168.0.1'],
    ['192.168.255.255'],
    ['127.0.0.1'],
    ['127.255.255.255'],
    ['169.254.1.1'],      // link-local / AWS metadata range
    ['100.64.0.1'],       // CGNAT shared
    ['0.0.0.1'],          // 0.x.x.x
    ['240.0.0.1'],        // reserved
    ['255.255.255.255'],
  ])('blocks private IPv4 %s', ip => {
    expect(validateHostLiteral(ip)).toMatch(/private|reserved/i);
  });

  // Private IPv6
  it.each([
    ['::1'],              // loopback
    ['fc00::1'],          // ULA
    ['fd12:3456::1'],     // ULA
    ['fe80::1'],          // link-local
    ['::ffff:127.0.0.1'], // IPv4-mapped loopback
    ['::ffff:192.168.1.1'], // IPv4-mapped private
    ['::ffff:10.0.0.1'],  // IPv4-mapped private
  ])('blocks private IPv6 %s', ip => {
    expect(validateHostLiteral(ip)).toMatch(/private|reserved/i);
  });

  // Bracket-wrapped IPv6
  it('blocks private IPv6 in bracket notation', () => {
    expect(validateHostLiteral('[::1]')).toMatch(/private|reserved/i);
  });

  it('passes public IPv6 in bracket notation', () => {
    expect(validateHostLiteral('[2001:db8::1]')).toBeNull();
  });

  it('trims whitespace before checking', () => {
    expect(validateHostLiteral('  localhost  ')).not.toBeNull();
    expect(validateHostLiteral('  8.8.8.8  ')).toBeNull();
  });
});

// ── validateHost (async) ───────────────────────────────────────────────────

describe('validateHost', () => {
  it('passes a hostname whose A records are public', async () => {
    dns.resolve4.mockResolvedValue(['142.250.80.46']);
    expect(await validateHost('imap.gmail.com')).toBeNull();
  });

  it('blocks a hostname whose A record resolves to a private IP', async () => {
    dns.resolve4.mockResolvedValue(['192.168.1.100']);
    expect(await validateHost('evil.attacker.com')).toMatch(/private|reserved/i);
  });

  it('blocks a hostname whose AAAA record resolves to a private IP', async () => {
    dns.resolve6.mockResolvedValue(['fd00::1']);
    expect(await validateHost('evil.attacker.com')).toMatch(/private|reserved/i);
  });

  it('passes when DNS resolution fails (connection will fail naturally)', async () => {
    dns.resolve4.mockRejectedValue(new Error('NXDOMAIN'));
    dns.resolve6.mockRejectedValue(new Error('NXDOMAIN'));
    expect(await validateHost('nonexistent.invalid')).toBeNull();
  });

  it('skips DNS lookup for a literal public IP', async () => {
    expect(await validateHost('8.8.8.8')).toBeNull();
    expect(dns.resolve4).not.toHaveBeenCalled();
  });

  it('short-circuits on literal check before DNS', async () => {
    expect(await validateHost('192.168.1.1')).toMatch(/private|reserved/i);
    expect(dns.resolve4).not.toHaveBeenCalled();
  });

  it('short-circuits on reserved hostname before DNS', async () => {
    expect(await validateHost('localhost')).not.toBeNull();
    expect(dns.resolve4).not.toHaveBeenCalled();
  });
});

// ── resolveForConnection ───────────────────────────────────────────────────

describe('resolveForConnection', () => {
  it('returns the literal IP with no servername for a public IPv4', async () => {
    const result = await resolveForConnection('8.8.8.8');
    expect(result.host).toBe('8.8.8.8');
    expect(result.servername).toBeNull();
    expect(dns.resolve4).not.toHaveBeenCalled();
  });

  it('returns the literal IP with no servername for a public IPv6', async () => {
    const result = await resolveForConnection('2001:db8::1');
    expect(result.host).toBe('2001:db8::1');
    expect(result.servername).toBeNull();
  });

  it('pins the resolved IP and sets servername for a public hostname', async () => {
    dns.resolve4.mockResolvedValue(['142.250.80.46']);
    const result = await resolveForConnection('imap.gmail.com');
    expect(result.host).toBe('142.250.80.46');
    expect(result.servername).toBe('imap.gmail.com');
  });

  it('throws for a hostname that resolves to a private IP', async () => {
    dns.resolve4.mockResolvedValue(['192.168.1.100']);
    await expect(resolveForConnection('evil.attacker.com')).rejects.toThrow(/private|reserved/i);
  });

  it('throws for a hostname that resolves to a private IPv6', async () => {
    dns.resolve6.mockResolvedValue(['fd00::1']);
    await expect(resolveForConnection('evil.attacker.com')).rejects.toThrow(/private|reserved/i);
  });

  it('throws for a literal private IP', async () => {
    await expect(resolveForConnection('10.0.0.1')).rejects.toThrow(/private|reserved/i);
    expect(dns.resolve4).not.toHaveBeenCalled();
  });

  it('throws for a reserved hostname', async () => {
    await expect(resolveForConnection('localhost')).rejects.toThrow();
    expect(dns.resolve4).not.toHaveBeenCalled();
  });

  it('falls back to the original hostname when DNS fails (NXDOMAIN)', async () => {
    dns.resolve4.mockRejectedValue(new Error('NXDOMAIN'));
    dns.resolve6.mockRejectedValue(new Error('NXDOMAIN'));
    const result = await resolveForConnection('nonexistent.invalid');
    expect(result.host).toBe('nonexistent.invalid');
    expect(result.servername).toBeNull();
  });

  it('trims whitespace from the hostname', async () => {
    dns.resolve4.mockResolvedValue(['142.250.80.46']);
    const result = await resolveForConnection('  imap.gmail.com  ');
    expect(result.servername).toBe('imap.gmail.com');
  });
});

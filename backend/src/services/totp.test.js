import { afterEach, describe, expect, it, vi } from 'vitest';
import { generate } from 'otplib';
import { generateTotpSecret, totpKeyUri, verifyTotp } from './totp.js';

// RFC 6238 test vector: the ASCII secret "12345678901234567890" in Base32.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

afterEach(() => {
  vi.useRealTimers();
});

describe('generateTotpSecret', () => {
  it('returns a 20-byte Base32 secret', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  });
});

describe('totpKeyUri', () => {
  it('builds an otpauth URI with the MailExpert issuer', () => {
    const uri = totpKeyUri('bob@example.com', RFC_SECRET);
    expect(uri.startsWith('otpauth://totp/MailExpert:bob%40example.com?')).toBe(true);
    const params = new URL(uri).searchParams;
    expect(params.get('secret')).toBe(RFC_SECRET);
    expect(params.get('issuer')).toBe('MailExpert');
  });
});

describe('verifyTotp', () => {
  it('accepts the RFC 6238 SHA-1 vector at T=59s', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(59 * 1000);
    // RFC 6238 lists 94287082 for 8 digits; the 6-digit code is its last six digits.
    expect(await verifyTotp('287082', RFC_SECRET)).toBe(true);
  });

  it('accepts the current code for a generated secret', async () => {
    const secret = generateTotpSecret();
    const token = await generate({ secret });
    expect(await verifyTotp(token, secret)).toBe(true);
  });

  it('rejects a code from the previous time step', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(59 * 1000 + 30 * 1000);
    expect(await verifyTotp('287082', RFC_SECRET)).toBe(false);
  });

  it('returns false instead of throwing for malformed codes', async () => {
    for (const token of ['', '12345', '1234567', 'abcdef', undefined, null, 123456]) {
      expect(await verifyTotp(token, RFC_SECRET)).toBe(false);
    }
  });

  it('returns false for a missing or unusable secret', async () => {
    expect(await verifyTotp('123456', null)).toBe(false);
    expect(await verifyTotp('123456', '')).toBe(false);
    expect(await verifyTotp('123456', 'GEZA')).toBe(false);
  });

  it('still verifies a legacy 10-byte secret enrolled by otplib 12', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // 282760 is what otplib 12's authenticator generated for this secret at T=0.
    expect(await verifyTotp('282760', 'JBSWY3DPEHPK3PXP')).toBe(true);
  });
});

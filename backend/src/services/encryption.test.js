import { hkdfSync } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const KEY = 'a1'.repeat(32);

// encryption.js caches the key it reads, so each case loads a fresh copy under its own env.
async function loadWithKey(key) {
  vi.resetModules();
  vi.stubEnv('ENCRYPTION_KEY', key);
  return import('./encryption.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('deriveKey', () => {
  it('derives each purpose its own key from ENCRYPTION_KEY with HKDF, never the raw key', async () => {
    const { deriveKey } = await loadWithKey(KEY);
    const key = deriveKey('rule-forward-loop');

    expect(key.equals(Buffer.from(
      hkdfSync('sha256', Buffer.from(KEY, 'hex'), Buffer.alloc(0), 'mailflow:rule-forward-loop', 32)
    ))).toBe(true);
    expect(deriveKey('rule-forward-loop').equals(key)).toBe(true);
    expect(key.equals(Buffer.from(KEY, 'hex'))).toBe(false);
    expect(deriveKey('another-purpose').equals(key)).toBe(false);
  });

  it('follows ENCRYPTION_KEY', async () => {
    const first = (await loadWithKey(KEY)).deriveKey('rule-forward-loop');
    const other = (await loadWithKey('5e'.repeat(32))).deriveKey('rule-forward-loop');

    expect(other.equals(first)).toBe(false);
  });

  it('returns null without a valid ENCRYPTION_KEY', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect((await loadWithKey('')).deriveKey('rule-forward-loop')).toBeNull();
    expect((await loadWithKey('abc')).deriveKey('rule-forward-loop')).toBeNull();
    // The right length for index.js, but not hex: it would parse to an empty key.
    expect((await loadWithKey('zz'.repeat(32))).deriveKey('rule-forward-loop')).toBeNull();
  });
});

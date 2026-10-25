import { createDecipheriv, hkdfSync, randomBytes } from 'crypto';
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

describe('encryptBytes / decryptBytes', () => {
  const opts = { purpose: 'scheduled-send', aad: 'scheduled:m1:u1:payload:1' };

  it('round-trips bytes', async () => {
    const { encryptBytes, decryptBytes } = await loadWithKey(KEY);
    const plaintext = Buffer.from('{"v":1,"subject":"Hi"}');
    const stored = encryptBytes(plaintext, opts);

    expect(Buffer.isBuffer(stored)).toBe(true);
    expect(stored.includes(plaintext)).toBe(false);
    expect(decryptBytes(stored, opts).equals(plaintext)).toBe(true);
  });

  it('stores 0x01 | iv | tag | ciphertext, under the purpose key and bound to the aad', async () => {
    const { encryptBytes } = await loadWithKey(KEY);
    const plaintext = Buffer.from('hello');
    const stored = encryptBytes(plaintext, opts);
    expect(stored.length).toBe(1 + 12 + 16 + plaintext.length);
    expect(stored[0]).toBe(0x01);

    const key = Buffer.from(hkdfSync('sha256', Buffer.from(KEY, 'hex'), Buffer.alloc(0), 'mailflow:scheduled-send', 32));
    const decipher = createDecipheriv('aes-256-gcm', key, stored.subarray(1, 13));
    decipher.setAAD(Buffer.from(opts.aad));
    decipher.setAuthTag(stored.subarray(13, 29));
    expect(Buffer.concat([decipher.update(stored.subarray(29)), decipher.final()]).equals(plaintext)).toBe(true);
  });

  it('uses a fresh iv for every value', async () => {
    const { encryptBytes } = await loadWithKey(KEY);
    const plaintext = Buffer.from('same');
    expect(encryptBytes(plaintext, opts).equals(encryptBytes(plaintext, opts))).toBe(false);
  });

  it('round-trips an empty buffer', async () => {
    const { encryptBytes, decryptBytes } = await loadWithKey(KEY);
    const stored = encryptBytes(Buffer.alloc(0), opts);
    expect(stored.length).toBe(29);
    expect(decryptBytes(stored, opts)).toEqual(Buffer.alloc(0));
  });

  it('round-trips a 1 MiB chunk', async () => {
    const { encryptBytes, decryptBytes } = await loadWithKey(KEY);
    const plaintext = randomBytes(1024 * 1024);
    const stored = encryptBytes(plaintext, opts);
    expect(stored.length).toBe(29 + plaintext.length);
    expect(decryptBytes(stored, opts).equals(plaintext)).toBe(true);
  });

  it('accepts a Buffer aad and a Uint8Array value, as pg may hand back', async () => {
    const { encryptBytes, decryptBytes } = await loadWithKey(KEY);
    const aad = Buffer.from(opts.aad);
    const stored = encryptBytes(Buffer.from('x'), { ...opts, aad });
    expect(decryptBytes(new Uint8Array(stored), opts).toString()).toBe('x');
  });

  it('returns null for a value that was tampered with anywhere', async () => {
    const { encryptBytes, decryptBytes } = await loadWithKey(KEY);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const stored = encryptBytes(Buffer.from('attachment chunk'), opts);
    // The version byte, the iv, the tag and the ciphertext.
    for (const at of [0, 1, 12, 13, 28, 29, stored.length - 1]) {
      const tampered = Buffer.from(stored);
      tampered[at] ^= 0x01;
      expect(decryptBytes(tampered, opts)).toBeNull();
    }
    expect(decryptBytes(stored.subarray(0, stored.length - 1), opts)).toBeNull();
    expect(decryptBytes(stored.subarray(0, 28), opts)).toBeNull();
    expect(decryptBytes(Buffer.concat([stored, Buffer.from([0])]), opts)).toBeNull();
    expect(decryptBytes('not bytes', opts)).toBeNull();
  });

  it('returns null under another aad or purpose, so a value cannot be moved', async () => {
    const { encryptBytes, decryptBytes } = await loadWithKey(KEY);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const stored = encryptBytes(Buffer.from('payload v1'), opts);
    expect(decryptBytes(stored, { ...opts, aad: 'scheduled:m1:u1:payload:2' })).toBeNull();
    expect(decryptBytes(stored, { ...opts, purpose: 'rule-forward-loop' })).toBeNull();
  });

  it('returns null under another ENCRYPTION_KEY', async () => {
    const stored = (await loadWithKey(KEY)).encryptBytes(Buffer.from('secret'), opts);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await loadWithKey('5e'.repeat(32))).decryptBytes(stored, opts)).toBeNull();
  });

  it('never runs without a valid ENCRYPTION_KEY: encrypt throws, decrypt returns null', async () => {
    const stored = (await loadWithKey(KEY)).encryptBytes(Buffer.from('secret'), opts);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { encryptBytes, decryptBytes } = await loadWithKey('');
    expect(() => encryptBytes(Buffer.from('secret'), opts)).toThrow(/ENCRYPTION_KEY/);
    expect(decryptBytes(stored, opts)).toBeNull();
  });

  it('requires a purpose, an aad and bytes', async () => {
    const { encryptBytes, decryptBytes } = await loadWithKey(KEY);
    expect(() => encryptBytes(Buffer.from('x'), { aad: 'a' })).toThrow(/purpose/);
    expect(() => encryptBytes(Buffer.from('x'), { purpose: 'scheduled-send' })).toThrow(/aad/);
    expect(() => encryptBytes('x', opts)).toThrow(/Buffer/);
    expect(() => decryptBytes(Buffer.alloc(29), { aad: 'a' })).toThrow(/purpose/);
    // An empty aad binds to nothing.
    expect(() => encryptBytes(Buffer.from('x'), { ...opts, aad: '' })).toThrow(TypeError);
    expect(() => encryptBytes(Buffer.from('x'), { ...opts, aad: Buffer.alloc(0) })).toThrow(TypeError);
    expect(() => decryptBytes(Buffer.alloc(29), { ...opts, aad: '' })).toThrow(TypeError);
  });
});

describe('decrypt', () => {
  it('round-trips a value from encrypt(), whose tag is always 16 bytes', async () => {
    const { encrypt, decrypt } = await loadWithKey(KEY);
    const stored = encrypt('app-password');
    expect(stored.split(':')[3]).toHaveLength(32);
    expect(decrypt(stored)).toBe('app-password');
  });

  it('rejects a truncated tag, which GCM would otherwise check against only its first bytes', async () => {
    const { encrypt, decrypt } = await loadWithKey(KEY);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const [ivHex, tagHex, ctHex] = encrypt('app-password').slice('enc:v1:'.length).split(':');
    for (const bytes of [4, 8, 12, 15]) {
      expect(decrypt(`enc:v1:${ivHex}:${tagHex.slice(0, bytes * 2)}:${ctHex}`)).toBeNull();
    }
  });
});

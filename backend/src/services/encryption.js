import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const PREFIX = 'enc:v1:';

// Cache the parsed key buffer so we don't re-allocate on every encrypt/decrypt call.
// Only cached when valid — null is not cached so a late-set env var is still picked up.
let _cachedKey = null;

function getKey() {
  if (_cachedKey) return _cachedKey;
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) return null;
  if (hex.length !== 64) {
    console.error('ENCRYPTION_KEY must be 64 hex characters (32 bytes). Credential encryption disabled.');
    return null;
  }
  _cachedKey = Buffer.from(hex, 'hex');
  return _cachedKey;
}

// A key for one purpose, derived from ENCRYPTION_KEY with HKDF, so a value keyed with it never
// uses the key that encrypts credentials, and each purpose gets an unrelated key. Null unless
// ENCRYPTION_KEY is 32 bytes of hex: index.js checks only its length, and 64 characters that
// are not hex parse to an empty key, which would make every derived value public.
const _derivedKeys = new Map();

export function deriveKey(purpose) {
  const cached = _derivedKeys.get(purpose);
  if (cached) return cached;
  const key = getKey();
  if (!key || key.length !== 32) return null;
  const derived = Buffer.from(crypto.hkdfSync('sha256', key, Buffer.alloc(0), `mailflow:${purpose}`, 32));
  _derivedKeys.set(purpose, derived);
  return derived;
}

// Bytes in, bytes out, for large values where the enc:v1 hex text form would double the size:
// 0x01 | iv (12) | tag (16) | ciphertext, AES-256-GCM like encrypt() but under deriveKey(purpose),
// never the credential key. `aad` (a non-empty string or Buffer) binds the value to where it is stored: it
// is authenticated, not stored, so a value copied to another place does not decrypt there.
const BYTES_VERSION = 0x01;
const TAG_BYTES = 16;
const BYTES_HEADER = 1 + IV_BYTES + TAG_BYTES;

function bytesKey(purpose) {
  if (typeof purpose !== 'string' || !purpose) throw new TypeError('purpose is required');
  return deriveKey(purpose);
}

// An empty aad would bind the value to nothing, so it is refused like a missing one.
function aadBuffer(aad) {
  const buf = Buffer.isBuffer(aad) ? aad : typeof aad === 'string' ? Buffer.from(aad, 'utf8') : null;
  if (!buf?.length) throw new TypeError('aad must be a non-empty string or Buffer');
  return buf;
}

// Throws if ENCRYPTION_KEY is not configured: callers must not silently store plaintext.
export function encryptBytes(plaintext, { purpose, aad } = {}) {
  if (!(plaintext instanceof Uint8Array)) throw new TypeError('plaintext must be a Buffer');
  const key = bytesKey(purpose);
  const additional = aadBuffer(aad);
  if (!key) throw new Error('ENCRYPTION_KEY is not set or invalid, cannot encrypt');

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(additional);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([BYTES_VERSION]), iv, cipher.getAuthTag(), encrypted]);
}

// Decrypts a value produced by encryptBytes() with the same purpose and aad. Returns null when it
// cannot be trusted: wrong or missing ENCRYPTION_KEY, another aad, tampered or truncated data.
export function decryptBytes(stored, { purpose, aad } = {}) {
  const key = bytesKey(purpose);
  const additional = aadBuffer(aad);
  if (!key) {
    console.error('ENCRYPTION_KEY not set, cannot decrypt stored data');
    return null;
  }
  if (!(stored instanceof Uint8Array) || stored.length < BYTES_HEADER || stored[0] !== BYTES_VERSION) {
    console.error('Malformed encrypted data');
    return null;
  }

  const data = Buffer.from(stored.buffer, stored.byteOffset, stored.length);
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, data.subarray(1, 1 + IV_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(additional);
    decipher.setAuthTag(data.subarray(1 + IV_BYTES, BYTES_HEADER));
    return Buffer.concat([decipher.update(data.subarray(BYTES_HEADER)), decipher.final()]);
  } catch {
    console.error('Failed to decrypt stored data: wrong ENCRYPTION_KEY or tampered data');
    return null;
  }
}

// Returns a prefixed string: enc:v1:<iv_hex>:<tag_hex>:<ciphertext_hex>
// Throws if ENCRYPTION_KEY is not configured — callers must not silently store plaintext credentials.
export function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  const key = getKey();
  if (!key) throw new Error('ENCRYPTION_KEY is not set or invalid — cannot encrypt credential');

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

// Decrypts a value produced by encrypt(). Returns the original value unchanged
// if it is not prefixed (plaintext) or if ENCRYPTION_KEY is not set.
export function decrypt(value) {
  if (!value || !value.startsWith(PREFIX)) return value;
  const key = getKey();
  if (!key) {
    console.error('ENCRYPTION_KEY not set — cannot decrypt stored credential');
    return null;
  }

  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 3) {
    console.error('Malformed encrypted credential');
    return null;
  }

  const [ivHex, tagHex, ctHex] = parts;
  try {
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const ciphertext = Buffer.from(ctHex, 'hex');
    // encrypt() always writes a 16-byte tag. Without the length, GCM accepts a tag cut down to
    // as little as 4 bytes and checks only those, which makes forging one far easier.
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext) + decipher.final('utf8');
  } catch {
    // Wrong ENCRYPTION_KEY (e.g. rotated without re-encrypting) or tampered data.
    // Return null so callers hit the uniform "corrupted credential" path instead of
    // throwing an opaque 500 / uncaught error.
    console.error('Failed to decrypt stored credential — wrong ENCRYPTION_KEY or tampered data');
    return null;
  }
}

// Returns true if a value is already encrypted with our scheme.
export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

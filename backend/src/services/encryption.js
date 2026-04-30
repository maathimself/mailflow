import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
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

// Returns a prefixed string: enc:v1:<iv_hex>:<tag_hex>:<ciphertext_hex>
// Returns the original value unchanged if ENCRYPTION_KEY is not set.
export function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  const key = getKey();
  if (!key) return plaintext;

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
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ciphertext = Buffer.from(ctHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

// Returns true if a value is already encrypted with our scheme.
export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

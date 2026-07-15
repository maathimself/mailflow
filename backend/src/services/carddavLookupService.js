import { query } from './db.js';
import { parseVCard } from '../utils/vcard.js';
import { decodeBase64Photo } from '../utils/vcardDocument.js';

// Inbound-sender avatar resolution for lookup-only CardDAV books.
//
// A lookup-only book (is_lookup_source && !is_subscribed) retains each remote
// object as a ledger row (mapping_status='lookup') with no materialized contact
// and — by design — no photo_data column (see multi-book-design.md, key
// decision 2). When an inbound sender resolves only against such a book its
// avatar is produced lazily: parse the retained vCard and pull its PHOTO through
// the same bounded decode path the rest of CardDAV uses. decodeBase64Photo
// enforces the 512 KiB limit and rejects malformed data, so an oversized or
// broken PHOTO yields no avatar rather than an unbounded buffer or a crash.
//
// That parse is comparatively expensive and the avatar endpoint is hit once per
// visible message row, so decoded results are memoized in a small in-process LRU
// keyed by (userId, lowercased email). The img URL is stable per email, so the
// browser caches the bytes too (Cache-Control on the route); this cache only
// spares the server the repeat DB read + vCard parse. It is intentionally
// best-effort: a sync that rewrites a sender's photo becomes visible once the
// entry's TTL elapses or it is evicted — acceptable for an avatar, and the
// escape hatch (a projected photo column) is deliberately deferred.

const PHOTO_CACHE_MAX_ENTRIES = 256;
const PHOTO_CACHE_TTL_MS = 10 * 60 * 1000;

// Map iteration order is insertion order, so re-inserting on read gives LRU
// recency and deleting the first key evicts the least-recently-used entry.
const photoCache = new Map();

function cacheKey(userId, email) {
  return `${userId} ${email}`;
}

function cacheGet(key) {
  const entry = photoCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    photoCache.delete(key);
    return undefined;
  }
  photoCache.delete(key);
  photoCache.set(key, entry);
  return entry.value;
}

function cacheSet(key, value) {
  photoCache.delete(key);
  photoCache.set(key, { value, expiresAt: Date.now() + PHOTO_CACHE_TTL_MS });
  while (photoCache.size > PHOTO_CACHE_MAX_ENTRIES) {
    photoCache.delete(photoCache.keys().next().value);
  }
}

// Test-only: drop all memoized avatars so LRU/TTL behavior is deterministic.
export function _clearLookupPhotoCache() {
  photoCache.clear();
}

// Extract raw image bytes for a lookup vCard's PHOTO, or null when it has none,
// is unparseable, or trips the bounded photo decoder (e.g. exceeds 512 KiB).
function decodeLookupPhoto(vcard) {
  let photoData;
  try {
    photoData = parseVCard(vcard).photoData;
  } catch {
    return null;
  }
  if (typeof photoData !== 'string' || !photoData.startsWith('data:')) return null;
  const match = /^data:([^;,]+);base64,(.*)$/is.exec(photoData);
  if (!match) return null;
  try {
    return { mime: match[1], bytes: decodeBase64Photo(match[2]) };
  } catch {
    return null;
  }
}

// The retained lookup rows for a user's lookup-only carddav books. $1 = userId;
// callers append the primary_email predicate ($2) and ordering. Shared by the
// single and batched probes so their scoping (lookup status, ownership, source,
// lookup-source flag) can never drift apart.
const LOOKUP_LEDGER_SOURCE = `
       FROM carddav_remote_objects o
       JOIN address_books ab ON ab.id = o.address_book_id
      WHERE o.mapping_status = 'lookup'
        AND ab.user_id = $1
        AND ab.source = 'carddav'
        AND ab.is_lookup_source = true`;

// Resolve an inbound sender's avatar from the user's lookup-only books. Returns
// { mime, bytes } for the retained vCard's PHOTO, or null when the sender is not
// in any lookup book (or that vCard carries no usable photo). Callers use this
// only after a miss in the materialized contacts table, so contacts-table photos
// always win over the ledger fallback.
export async function resolveLookupPhoto(userId, email) {
  const normalized = String(email ?? '').trim().toLowerCase();
  if (!normalized) return null;

  const key = cacheKey(userId, normalized);
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const { rows } = await query(
    `SELECT o.vcard${LOOKUP_LEDGER_SOURCE}
        AND o.primary_email = $2
      ORDER BY o.updated_at DESC
      LIMIT 1`,
    [userId, normalized],
  );
  const result = rows.length ? decodeLookupPhoto(rows[0].vcard) : null;
  cacheSet(key, result);
  return result;
}

// Batched sibling of resolveLookupPhoto: resolve many senders' avatars in a
// single DB round-trip. A message page can name hundreds of distinct lookup-only
// senders; probing one query each (a Promise.all fan-out) floods the ~20-slot
// connection pool. Cache hits are served from the shared LRU and only the misses
// reach the DB, in one `primary_email = ANY(...)` probe whose DISTINCT ON keeps
// the most-recent row per sender — the same choice resolveLookupPhoto's LIMIT 1
// makes. Per-sender decode + memoization is identical, so both functions share a
// cache and the photo route keeps reading whatever this primed. Returns a Map of
// normalized email -> { mime, bytes } | null covering every requested email.
export async function resolveLookupPhotos(userId, emails) {
  const results = new Map();
  const misses = [];
  for (const email of emails) {
    const normalized = String(email ?? '').trim().toLowerCase();
    if (!normalized || results.has(normalized)) continue;
    const cached = cacheGet(cacheKey(userId, normalized));
    if (cached !== undefined) {
      results.set(normalized, cached);
      continue;
    }
    results.set(normalized, null);
    misses.push(normalized);
  }
  if (!misses.length) return results;

  const { rows } = await query(
    `SELECT DISTINCT ON (o.primary_email) o.primary_email, o.vcard${LOOKUP_LEDGER_SOURCE}
        AND o.primary_email = ANY($2::text[])
      ORDER BY o.primary_email, o.updated_at DESC`,
    [userId, misses],
  );
  const vcardByEmail = new Map(rows.map(row => [row.primary_email, row.vcard]));
  for (const email of misses) {
    const vcard = vcardByEmail.get(email);
    const result = vcard ? decodeLookupPhoto(vcard) : null;
    cacheSet(cacheKey(userId, email), result);
    results.set(email, result);
  }
  return results;
}

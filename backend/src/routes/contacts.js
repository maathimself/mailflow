import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { generateVCard } from '../utils/vcard.js';
import { safeFetch } from '../services/safeFetch.js';
import crypto from 'crypto';

const router = Router();
router.use(requireAuth);

// In-memory cache for Gravatar lookups (hash -> { buf, type } hit or { miss:true }).
// Bounded + TTL'd so we don't re-hit Gravatar for every list render and so the number of
// third-party requests stays minimal (a privacy consideration — see the /gravatar route).
const gravatarCache = new Map();
const GRAVATAR_TTL_MS      = 24 * 60 * 60 * 1000; // hits: 24h
const GRAVATAR_MISS_TTL_MS =  6 * 60 * 60 * 1000; // 404s: 6h
const GRAVATAR_MAX_ENTRIES = 2000;
function gravatarCacheSet(hash, entry) {
  if (gravatarCache.size >= GRAVATAR_MAX_ENTRIES) {
    const oldest = gravatarCache.keys().next().value;
    if (oldest !== undefined) gravatarCache.delete(oldest);
  }
  gravatarCache.set(hash, entry);
}

// Resolve the user's default address book id, creating it if needed.
async function defaultAddressBook(userId) {
  const r = await query(
    `INSERT INTO address_books (user_id, name)
     VALUES ($1, 'Personal')
     ON CONFLICT (user_id, name) DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [userId]
  );
  return r.rows[0].id;
}

// Bump the address book sync_token so CardDAV clients re-sync.
async function bumpSyncToken(addressBookId) {
  await query(
    `UPDATE address_books SET sync_token = gen_random_uuid()::text, updated_at = NOW()
     WHERE id = $1`,
    [addressBookId]
  );
}

// GET /api/contacts
// Query params: q (search), limit, offset, is_auto (true|false|'')
router.get('/', async (req, res) => {
  const { q, limit = 50, offset = 0, is_auto } = req.query;
  const userId = req.session.userId;
  const cap = Math.min(parseInt(limit) || 50, 500);
  const off = Math.max(0, parseInt(offset) || 0);

  const conditions = ['c.user_id = $1'];
  const params = [userId];
  let p = 2;

  if (q && q.trim()) {
    params.push(`%${q.trim()}%`);
    conditions.push(`(
      c.display_name ILIKE $${p}
      OR c.primary_email ILIKE $${p}
      OR c.organization ILIKE $${p}
      OR (jsonb_typeof(c.emails) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(c.emails) ae WHERE ae->>'value' ILIKE $${p}))
      OR (jsonb_typeof(c.phones) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(c.phones) ap WHERE ap->>'value' ILIKE $${p}))
    )`);
    p++;
  }

  if (is_auto === 'true') {
    conditions.push('c.is_auto = true');
  } else if (is_auto === 'false') {
    conditions.push('c.is_auto = false');
  }

  try {
    const result = await query(`
      SELECT
        c.id, c.uid, c.display_name, c.first_name, c.last_name,
        c.primary_email, c.emails, c.phones, c.organization,
        c.notes, c.is_auto, c.send_count, c.last_sent,
        c.etag, c.created_at, c.updated_at,
        (ab.source = 'carddav') AS read_only
      FROM contacts c
      JOIN address_books ab ON ab.id = c.address_book_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY
        c.is_auto ASC,
        c.send_count DESC,
        lower(coalesce(c.display_name, c.primary_email, '')) ASC
      LIMIT $${p} OFFSET $${p + 1}
    `, [...params, cap, off]);

    const total = await query(
      `SELECT COUNT(*) FROM contacts c WHERE ${conditions.join(' AND ')}`,
      params
    );

    res.json({ contacts: result.rows, total: parseInt(total.rows[0].count) });
  } catch (err) {
    console.error('Contacts list error:', err);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

// GET /api/contacts/photo?email=:email
// Returns the contact photo for the given sender email as image bytes.
// This route must remain ABOVE /:id to prevent Express matching "photo" as an id.
router.get('/photo', async (req, res) => {
  const { email } = req.query;
  const userId = req.session.userId;

  if (!email || typeof email !== 'string') return res.status(400).end();

  try {
    const result = await query(
      `SELECT photo_data FROM contacts
       WHERE user_id = $1 AND primary_email = lower($2) AND photo_data IS NOT NULL
       LIMIT 1`,
      [userId, email.trim()]
    );

    if (!result.rows.length) return res.status(404).end();

    const photoData = result.rows[0].photo_data;
    res.set('Cache-Control', 'private, max-age=86400');

    if (photoData.startsWith('data:')) {
      const commaIdx = photoData.indexOf(',');
      if (commaIdx < 0) return res.status(404).end();
      const mimeMatch = photoData.slice(0, commaIdx).match(/data:([^;]+)/);
      const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
      res.set('Content-Type', mimeType);
      return res.send(Buffer.from(photoData.slice(commaIdx + 1), 'base64'));
    }

    // Fallback: treat as raw base64 JPEG (shouldn't occur after vcard.js fix).
    res.set('Content-Type', 'image/jpeg');
    return res.send(Buffer.from(photoData, 'base64'));
  } catch (err) {
    console.error('Contact photo error:', err);
    res.status(500).end();
  }
});

// GET /api/contacts/gravatar?email=:email
// Server-side proxy for Gravatar sender avatars (#213). OPT-IN only — the frontend never
// calls this unless the user turns on the "Gravatar avatars" preference. Proxied (rather
// than hit directly from the browser) so the user's IP is never exposed to Gravatar, and
// cached so repeated list renders don't fan out third-party requests. Privacy note: even so,
// this server reveals the hashed sender address to Gravatar (Automattic) for each miss —
// that is inherent to the feature and disclosed in the settings toggle.
// Must remain ABOVE /:id (like /photo) so Express doesn't match "gravatar" as an id.
router.get('/gravatar', async (req, res) => {
  const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
  // Basic RFC-ish shape check; also bounds the input before hashing / logging.
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).end();
  }
  const hash = crypto.createHash('sha256').update(email).digest('hex');
  const now = Date.now();

  const cached = gravatarCache.get(hash);
  if (cached && cached.expires > now) {
    if (cached.miss) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=86400');
    res.set('Content-Type', cached.type);
    return res.send(cached.buf);
  }

  try {
    // Host is fixed (only the hex hash varies) so there is no SSRF surface; safeFetch still
    // pins to the resolved public IP and blocks private ranges. d=404 → Gravatar returns 404
    // when the address has no avatar, so the client falls back to initials.
    const url = `https://www.gravatar.com/avatar/${hash}?d=404&s=80&r=g`;
    const resp = await safeFetch(url, {
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': 'Mailflow/1.0' },
    });
    if (resp.status === 404) {
      gravatarCacheSet(hash, { miss: true, expires: now + GRAVATAR_MISS_TTL_MS });
      return res.status(404).end();
    }
    const type = resp.headers.get('content-type') || '';
    if (!resp.ok || !type.startsWith('image/')) return res.status(502).end();
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0 || buf.length > 512 * 1024) return res.status(502).end();
    gravatarCacheSet(hash, { buf, type, expires: now + GRAVATAR_TTL_MS });
    res.set('Cache-Control', 'private, max-age=86400');
    res.set('Content-Type', type);
    return res.send(buf);
  } catch (err) {
    return res.status(502).end();
  }
});

// GET /api/contacts/:id
router.get('/:id', async (req, res) => {
  const userId = req.session.userId;
  try {
    const result = await query(
      `SELECT c.id, c.uid, c.display_name, c.first_name, c.last_name,
              c.primary_email, c.emails, c.phones, c.organization,
              c.notes, c.photo_data, c.is_auto, c.send_count, c.last_sent,
              c.etag, c.vcard, c.created_at, c.updated_at,
              (ab.source = 'carddav') AS read_only
       FROM contacts c
       JOIN address_books ab ON ab.id = c.address_book_id
       WHERE c.id = $1 AND c.user_id = $2`,
      [req.params.id, userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Contact not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Contact get error:', err);
    res.status(500).json({ error: 'Failed to fetch contact' });
  }
});

// POST /api/contacts
router.post('/', async (req, res) => {
  const userId = req.session.userId;
  const {
    displayName, firstName, lastName,
    emails = [], phones = [],
    organization, notes,
  } = req.body || {};

  if (!Array.isArray(emails)) return res.status(400).json({ error: 'emails must be an array' });
  if (!Array.isArray(phones)) return res.status(400).json({ error: 'phones must be an array' });

  const primaryEmail = emails[0]?.value
    ? emails[0].value.toLowerCase().trim()
    : null;

  if (!displayName && !primaryEmail) {
    return res.status(400).json({ error: 'A name or email address is required' });
  }

  try {
    const addressBookId = await defaultAddressBook(userId);
    const uid = crypto.randomUUID();
    const vcard = generateVCard({ uid, displayName, firstName, lastName, emails, phones, organization, notes });
    const etag = crypto.createHash('md5').update(vcard).digest('hex');

    const result = await query(`
      INSERT INTO contacts (
        address_book_id, user_id, uid, vcard, etag,
        display_name, first_name, last_name, primary_email,
        emails, phones, organization, notes, is_auto
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, false)
      RETURNING id, uid, display_name, first_name, last_name,
                primary_email, emails, phones, organization, notes,
                is_auto, send_count, last_sent, etag, created_at, updated_at
    `, [
      addressBookId, userId, uid, vcard, etag,
      displayName || null, firstName || null, lastName || null, primaryEmail,
      JSON.stringify(emails), JSON.stringify(phones),
      organization || null, notes || null,
    ]);

    await bumpSyncToken(addressBookId);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A contact with that email already exists' });
    console.error('Contact create error:', err);
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

// PATCH /api/contacts/:id
router.patch('/:id', async (req, res) => {
  const userId = req.session.userId;
  const {
    displayName, firstName, lastName,
    emails, phones, organization, notes,
  } = req.body || {};

  if (emails !== undefined && !Array.isArray(emails)) return res.status(400).json({ error: 'emails must be an array' });
  if (phones !== undefined && !Array.isArray(phones)) return res.status(400).json({ error: 'phones must be an array' });

  try {
    // Load current contact (with its book source to block edits to synced contacts)
    const cur = await query(
      `SELECT c.*, ab.source AS book_source FROM contacts c
       JOIN address_books ab ON ab.id = c.address_book_id
       WHERE c.id = $1 AND c.user_id = $2`,
      [req.params.id, userId]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Contact not found' });
    const c = cur.rows[0];
    if (c.book_source === 'carddav') {
      return res.status(403).json({ error: 'This contact is synced from CardDAV and is read-only' });
    }

    const newEmails    = emails    !== undefined ? emails    : c.emails;
    const newPhones    = phones    !== undefined ? phones    : c.phones;
    const newDisplay   = displayName  !== undefined ? displayName  : c.display_name;
    const newFirst     = firstName    !== undefined ? firstName    : c.first_name;
    const newLast      = lastName     !== undefined ? lastName     : c.last_name;
    const newOrg       = organization !== undefined ? organization : c.organization;
    const newNotes     = notes        !== undefined ? notes        : c.notes;
    const newPrimary   = emails === undefined
      ? c.primary_email
      : (newEmails[0]?.value ? newEmails[0].value.toLowerCase().trim() : null);

    const vcard = generateVCard({
      uid: c.uid,
      displayName: newDisplay,
      firstName: newFirst,
      lastName: newLast,
      emails: newEmails,
      phones: newPhones,
      organization: newOrg,
      notes: newNotes,
    });
    const etag = crypto.createHash('md5').update(vcard).digest('hex');

    const result = await query(`
      UPDATE contacts SET
        display_name = $1, first_name = $2, last_name = $3,
        primary_email = $4, emails = $5, phones = $6,
        organization = $7, notes = $8,
        vcard = $9, etag = $10, updated_at = NOW(),
        is_auto = false
      WHERE id = $11 AND user_id = $12
      RETURNING id, uid, display_name, first_name, last_name,
                primary_email, emails, phones, organization, notes,
                is_auto, send_count, last_sent, etag, created_at, updated_at
    `, [
      newDisplay || null, newFirst || null, newLast || null,
      newPrimary,
      JSON.stringify(newEmails), JSON.stringify(newPhones),
      newOrg || null, newNotes || null,
      vcard, etag,
      req.params.id, userId,
    ]);

    await bumpSyncToken(c.address_book_id);
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A contact with that email already exists' });
    console.error('Contact update error:', err);
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// DELETE /api/contacts/:id
router.delete('/:id', async (req, res) => {
  const userId = req.session.userId;
  try {
    // Block deletion of CardDAV-synced (read-only) contacts; they reappear on next sync anyway.
    const owner = await query(
      `SELECT ab.source FROM contacts c JOIN address_books ab ON ab.id = c.address_book_id
       WHERE c.id = $1 AND c.user_id = $2`,
      [req.params.id, userId]
    );
    if (!owner.rows.length) return res.status(404).json({ error: 'Contact not found' });
    if (owner.rows[0].source === 'carddav') {
      return res.status(403).json({ error: 'This contact is synced from CardDAV and is read-only' });
    }
    const result = await query(
      'DELETE FROM contacts WHERE id = $1 AND user_id = $2 RETURNING address_book_id',
      [req.params.id, userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Contact not found' });
    await bumpSyncToken(result.rows[0].address_book_id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Contact delete error:', err);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

export default router;

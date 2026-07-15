import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import {
  CARDDAV_CONTACT_ERROR_STATUS,
  createContact,
  deleteContact,
  promoteContact,
  updateContact,
} from '../services/carddavContactService.js';
import { resolveLookupPhoto } from '../services/carddavLookupService.js';

const router = Router();
router.use(requireAuth);

const MAX_PHOTO_BYTES = 512 * 1024;

const CONTACT_SYNC_COLUMNS = `
        COALESCE(mapping.mapping_status, 'local') AS sync_state,
        remote_book.remote_create_capability,
        remote_book.remote_update_capability,
        remote_book.remote_delete_capability,
        (c.photo_data IS NOT NULL) AS has_photo,
        conflict.id AS conflict_id,
        (mapping.local_contact_id IS NOT NULL
          AND remote_book.remote_update_capability = 'denied'
          AND remote_book.remote_delete_capability = 'denied') AS read_only`;
const CONTACT_SYNC_JOINS = `
      LEFT JOIN carddav_remote_objects mapping
        ON mapping.local_contact_id = c.id
       AND mapping.mapping_status <> 'pending_materialization'
      LEFT JOIN address_books remote_book ON remote_book.id = mapping.address_book_id
      LEFT JOIN carddav_conflicts conflict
        ON conflict.address_book_id = mapping.address_book_id
       AND conflict.href = mapping.href
       AND conflict.status = 'unresolved'`;

function validateDraft(draft) {
  if (draft.emails !== undefined && !Array.isArray(draft.emails)) return 'emails must be an array';
  if (draft.phones !== undefined && !Array.isArray(draft.phones)) return 'phones must be an array';
  if (draft.additionalFields !== undefined && !Array.isArray(draft.additionalFields)) {
    return 'additionalFields must be an array';
  }
  if (draft.photoData === undefined || draft.photoData === null) return null;
  if (typeof draft.photoData !== 'string') return 'photoData must be a JPEG or PNG data URI';

  const match = /^data:([^;,]+);base64,(.*)$/i.exec(draft.photoData);
  if (!match || !/^image\/(?:jpeg|png)$/i.test(match[1])) {
    return 'photoData must be a JPEG or PNG data URI';
  }
  const encoded = match[2];
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    return 'photoData must contain valid base64 data';
  }
  if (Buffer.from(encoded, 'base64').length > MAX_PHOTO_BYTES) {
    return 'photoData must not exceed 512 KiB';
  }
  return null;
}

function contactError(res, err, fallback) {
  if (err.code === 'ERR_CARDDAV_CONFLICT') {
    return res.status(CARDDAV_CONTACT_ERROR_STATUS[err.code]).json({ conflictId: err.conflictId });
  }
  // A concurrent sync (or reconnect) can move the mapping fence out from under an
  // in-flight write whose remote effect already landed — a transient, self-healing
  // race, not a client error. Surface it as retriable with a machine-readable code
  // so the client re-issues the edit instead of treating it as a 500.
  // (ERR_CARDDAV_STALE_GENERATION is a defensive mapping — no current contacts-route
  //  path throws it; only exportExistingContact does, and its caller handles it.)
  if (err.code === 'ERR_CARDDAV_FINAL_FENCE' || err.code === 'ERR_CARDDAV_STALE_GENERATION') {
    return res.status(CARDDAV_CONTACT_ERROR_STATUS[err.code])
      .json({ error: err.message, code: err.code, retriable: true });
  }
  // A post-write ambiguous result (the remote effect may already have landed; the
  // service persisted a pending intent and recovered read-only) or a rejected write
  // because another mutation is still awaiting confirmation. Neither is safe to
  // re-issue — the client must refresh state and let the next sync reconcile, so map
  // to 409 with `refresh` and deliberately WITHOUT `retriable`.
  if (err.code === 'ERR_CARDDAV_AMBIGUOUS_WRITE' || err.code === 'ERR_CARDDAV_PENDING_INTENT') {
    return res.status(CARDDAV_CONTACT_ERROR_STATUS[err.code])
      .json({ error: err.message, code: err.code, refresh: true });
  }
  // The code rides along with the message so a client can translate the states
  // it can act on (no write-target, read-only book) instead of echoing a raw
  // English message into a localized UI.
  if (err.code === '23505') {
    return res.status(CARDDAV_CONTACT_ERROR_STATUS[err.code])
      .json({ error: 'A contact with that email already exists' });
  }
  const status = CARDDAV_CONTACT_ERROR_STATUS[err.code]
    ?? (Number.isInteger(err.status) ? err.status : null);
  if (status) return res.status(status).json({ error: err.message, code: err.code });
  console.error(`${fallback}:`, err);
  return res.status(500).json({ error: fallback });
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
        c.notes, c.additional_fields,
        c.is_auto, c.send_count, c.last_sent,
        c.etag, c.created_at, c.updated_at,
        ${CONTACT_SYNC_COLUMNS}
      FROM contacts c
      JOIN address_books ab ON ab.id = c.address_book_id
      ${CONTACT_SYNC_JOINS}
      WHERE ${conditions.join(' AND ')}
      ORDER BY
        c.is_auto ASC,
        c.send_count DESC,
        lower(coalesce(c.display_name, c.primary_email, '')) ASC,
        c.id ASC
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

    // Ledger fallback: a sender materialized in no contacts row may still live in
    // a lookup-only CardDAV book, whose retained vCard PHOTO is decoded lazily.
    // Contacts-table photos are resolved first, so they always win.
    if (!result.rows.length) {
      const lookup = await resolveLookupPhoto(userId, email);
      if (lookup) {
        res.set('Cache-Control', 'private, max-age=86400');
        res.set('Content-Type', lookup.mime);
        return res.send(lookup.bytes);
      }
      return res.status(404).end();
    }

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

// GET /api/contacts/:id
router.get('/:id', async (req, res) => {
  const userId = req.session.userId;
  try {
    const result = await query(
      `SELECT c.id, c.uid, c.display_name, c.first_name, c.last_name,
              c.primary_email, c.emails, c.phones, c.organization,
              c.notes, c.photo_data, c.additional_fields,
              c.is_auto, c.send_count, c.last_sent,
              c.etag, c.created_at, c.updated_at,
              ${CONTACT_SYNC_COLUMNS}
       FROM contacts c
       JOIN address_books ab ON ab.id = c.address_book_id
       ${CONTACT_SYNC_JOINS}
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
  const draft = req.body || {};
  const validationError = validateDraft(draft);
  if (validationError) return res.status(400).json({ error: validationError });

  try {
    res.status(201).json(await createContact(userId, draft));
  } catch (err) {
    contactError(res, err, 'Failed to create contact');
  }
});

// PATCH /api/contacts/:id
router.patch('/:id', async (req, res) => {
  const userId = req.session.userId;
  const draft = req.body || {};
  const validationError = validateDraft(draft);
  if (validationError) return res.status(400).json({ error: validationError });

  try {
    res.json(await updateContact(userId, req.params.id, draft));
  } catch (err) {
    contactError(res, err, 'Failed to update contact');
  }
});

// POST /api/contacts/:id/promote
// Make an auto-collected contact explicit and export it to the CardDAV
// write-target book right away. Editing a harvested contact deliberately does
// not do this (see updateStoredContact) — publishing a sender to a shared
// address book is a one-way action the user takes on purpose, never a side
// effect of tidying up a field.
router.post('/:id/promote', async (req, res) => {
  try {
    res.json(await promoteContact(req.session.userId, req.params.id));
  } catch (err) {
    contactError(res, err, 'Failed to save contact to the address book');
  }
});

// DELETE /api/contacts/:id
router.delete('/:id', async (req, res) => {
  const userId = req.session.userId;
  try {
    res.json(await deleteContact(userId, req.params.id));
  } catch (err) {
    contactError(res, err, 'Failed to delete contact');
  }
});

export default router;

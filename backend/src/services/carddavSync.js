// CardDAV sync orchestration + scheduler. Pulls contacts from a user's connected
// CardDAV server (provider='carddav' in user_integrations) into per-remote-book,
// read-only local address books. One-way / read-only. Duplicate handling across
// books is chosen by the user: 'separate' | 'merge' | 'skip'.

import crypto from 'crypto';
import { query } from './db.js';
import { decrypt } from './encryption.js';
import { parseVCard, generateVCard } from '../utils/vcard.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { discoverAddressBooks, fetchAddressBookCards } from './carddavClient.js';

const DEFAULT_INTERVAL_MIN = 60;
const timers = new Map();   // userId -> interval id
const syncing = new Set();  // userIds with a sync in flight (prevents overlap)

export async function getCardavConfig(userId) {
  const r = await query(
    "SELECT config FROM user_integrations WHERE user_id = $1 AND provider = 'carddav'",
    [userId],
  );
  return r.rows[0]?.config || null;
}

// Shallow-merge a patch into the stored JSONB config.
export async function saveCardavConfig(userId, patch) {
  await query(
    `UPDATE user_integrations SET config = config || $2::jsonb, updated_at = NOW()
     WHERE user_id = $1 AND provider = 'carddav'`,
    [userId, JSON.stringify(patch)],
  );
}

// Find or create the local read-only address book mirroring a remote collection,
// keyed by external_url. Address-book names are unique per user, so on a name
// clash we disambiguate with a suffix.
async function ensureCardavBook(userId, book) {
  const existing = await query(
    "SELECT id FROM address_books WHERE user_id = $1 AND external_url = $2",
    [userId, book.url],
  );
  if (existing.rows.length) return existing.rows[0].id;

  for (let attempt = 0; attempt < 20; attempt++) {
    const name = attempt === 0 ? book.displayName : `${book.displayName} (${attempt + 1})`;
    try {
      const r = await query(
        `INSERT INTO address_books (user_id, name, source, external_url)
         VALUES ($1, $2, 'carddav', $3) RETURNING id`,
        [userId, name, book.url],
      );
      return r.rows[0].id;
    } catch (err) {
      if (err.code === '23505') continue; // name taken — try next suffix
      throw err;
    }
  }
  throw new Error(`Could not create a local address book for "${book.displayName}"`);
}

function contactFromVCard(vcard, href) {
  const c = parseVCard(vcard);
  const uid = c.uid || crypto.createHash('md5').update(href).digest('hex');
  const primaryEmail = c.emails.find(e => e.primary)?.value || c.emails[0]?.value || null;
  return {
    uid,
    displayName: c.displayName || primaryEmail || null,
    firstName: c.firstName, lastName: c.lastName,
    primaryEmail: primaryEmail ? primaryEmail.toLowerCase().trim() : null,
    emails: c.emails, phones: c.phones,
    organization: c.organization, notes: c.notes, photoData: c.photoData,
    vcard,
  };
}

async function upsertCardavContact(bookId, userId, c) {
  const etag = crypto.createHash('md5').update(c.vcard).digest('hex');
  await query(`
    INSERT INTO contacts (
      address_book_id, user_id, uid, vcard, etag,
      display_name, first_name, last_name, primary_email,
      emails, phones, organization, notes, photo_data, is_auto
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,false)
    ON CONFLICT (address_book_id, uid) DO UPDATE SET
      vcard = EXCLUDED.vcard, etag = EXCLUDED.etag,
      display_name = EXCLUDED.display_name, first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name, primary_email = EXCLUDED.primary_email,
      emails = EXCLUDED.emails, phones = EXCLUDED.phones,
      organization = EXCLUDED.organization, notes = EXCLUDED.notes,
      photo_data = EXCLUDED.photo_data, updated_at = NOW()
  `, [
    bookId, userId, c.uid, c.vcard, etag,
    c.displayName, c.firstName, c.lastName, c.primaryEmail,
    JSON.stringify(c.emails), JSON.stringify(c.phones),
    c.organization, c.notes, c.photoData,
  ]);
}

// Enrich an existing contact (in another book) with the vCard's descriptive
// fields. Values the card lacks are kept rather than cleared: MailFlow cannot tell
// a value the user entered from one an earlier sync copied from the card. A contact
// that an earlier book already merged this sync only has its gaps filled, so two
// books that disagree settle instead of rewriting it on every sync.
// We deliberately leave primary_email/emails untouched to avoid churning that
// book's per-book email-uniqueness index.
async function mergeIntoExisting(id, c, fillOnly) {
  const cur = await query(
    `SELECT address_book_id, uid, vcard, etag, primary_email, display_name, first_name, last_name,
            emails, phones, organization, notes, photo_data
     FROM contacts WHERE id = $1`,
    [id],
  );
  const row = cur.rows[0];
  // Deleted, or given another address, since syncBook matched it to this card.
  if (!row || row.primary_email?.toLowerCase() !== c.primaryEmail) return null;
  const own = {
    uid: row.uid, displayName: row.display_name, firstName: row.first_name, lastName: row.last_name,
    emails: row.emails, phones: row.phones, organization: row.organization, notes: row.notes,
  };
  // A display name that is only the email address is not a name, on either side:
  // contactFromVCard falls back to the address when a card has no FN, and MailFlow
  // names a contact it adds from mail after its address.
  const nameOf = name => (name?.toLowerCase() === c.primaryEmail ? null : name);
  const card = { ...c, displayName: nameOf(c.displayName) };
  const mine = { ...own, displayName: nameOf(own.displayName) };
  const [preferred, fallback] = fillOnly ? [mine, card] : [card, mine];
  const pick = field => preferred[field] || fallback[field];
  // The contact editor saves a number as typed; parseVCard trims the card's.
  const numberOf = p => (p.value || '').trim();
  const ownNumbers = new Set(own.phones.map(numberOf));
  // Each card entry stands in for at most one of the contact's, and the entries left
  // over are added after them, so a number the card lists twice keeps both types. A TEL
  // without TYPE, which parseVCard reads as 'other', keeps the contact's type. A later
  // book only adds the numbers the contact does not have.
  const unmatched = fillOnly ? card.phones.filter(p => !ownNumbers.has(p.value)) : [...card.phones];
  const fromCard = p => {
    const i = unmatched.findIndex(cp => cp.value === numberOf(p));
    if (i < 0) return p;
    const [match] = unmatched.splice(i, 1);
    return match.type === 'other' ? { ...match, type: p.type } : match;
  };
  // In the contact's own order, so a client that reorders its numbers does not cause a
  // rewrite.
  const ownPhones = fillOnly ? own.phones : own.phones.map(fromCard);
  const merged = {
    ...own,
    // A contact named after its address keeps that name while no card has a real one.
    displayName: pick('displayName') || own.displayName,
    firstName: pick('firstName'),
    lastName: pick('lastName'),
    phones: [...ownPhones, ...unmatched],
    organization: pick('organization'),
    notes: pick('notes'),
  };
  const photoData = fillOnly && row.photo_data ? null : c.photoData;
  const vcard = generateVCard(merged);
  // Regenerating the card drops what a client stored that MailFlow does not model
  // (ADR, BDAY, ...), so an unchanged contact is left alone unless its stored card
  // is missing or is the remote card an earlier merge copied in.
  const storedUid = parseVCard(row.vcard).uid;
  const replaceCard = storedUid !== row.uid && (!storedUid || storedUid === c.uid);
  // The generated FN falls back to the first and last name, so compare the display name too.
  const sameName = (merged.displayName || null) === (own.displayName || null);
  if (vcard === generateVCard(own) && sameName && (!photoData || photoData === row.photo_data)
      && !replaceCard) return null;
  const etag = crypto.createHash('md5').update(vcard).digest('hex');
  // Only if the contact is unchanged since it was read: an edit made meanwhile wins.
  const r = await query(`
    UPDATE contacts SET
      display_name = $2, first_name = $3, last_name = $4,
      phones = $5::jsonb, organization = $6, notes = $7,
      photo_data = COALESCE($8, photo_data), vcard = $9, etag = $10, updated_at = NOW()
    WHERE id = $1 AND etag = $11
  `, [id, merged.displayName, merged.firstName, merged.lastName, JSON.stringify(merged.phones),
      merged.organization, merged.notes, photoData, vcard, etag, row.etag]);
  return r.rowCount ? row.address_book_id : null;
}

async function syncBook(userId, book, dupMode, creds, mergedIds) {
  const bookId = await ensureCardavBook(userId, book);
  const rawCards = await fetchAddressBookCards({ ...book, ...creds });
  const cards = rawCards.map(rc => contactFromVCard(rc.vcard, rc.href));

  // Emails present in the user's OTHER books, for cross-book duplicate handling.
  const otherEmail = new Map(); // email -> existing contact id
  if (dupMode !== 'separate') {
    const rows = await query(
      `SELECT id, primary_email FROM contacts
       WHERE user_id = $1 AND address_book_id <> $2 AND primary_email IS NOT NULL`,
      [userId, bookId],
    );
    for (const r of rows.rows) otherEmail.set(r.primary_email.toLowerCase(), r.id);
  }

  // Classify first (no writes) so we know the final set before touching the DB.
  const seenInBook = new Set();
  const toUpsert = [];
  const toMerge = []; // { id, contact }
  for (const c of cards) {
    // Avoid violating this book's (address_book_id, primary_email) uniqueness when
    // two cards in the same book share an email — keep the email on the first only.
    if (c.primaryEmail && seenInBook.has(c.primaryEmail)) c.primaryEmail = null;
    else if (c.primaryEmail) seenInBook.add(c.primaryEmail);

    if (c.primaryEmail && dupMode !== 'separate' && otherEmail.has(c.primaryEmail)) {
      if (dupMode === 'skip') continue;
      if (dupMode === 'merge') { toMerge.push({ id: otherEmail.get(c.primaryEmail), contact: c }); continue; }
    }
    toUpsert.push(c);
  }

  const presentUids = toUpsert.map(c => c.uid);
  // Delete stale rows BEFORE upserting so a uid/email freed this round can't collide
  // with an incoming card (e.g. an email moving to a newly-created contact).
  await query(
    `DELETE FROM contacts WHERE address_book_id = $1 AND uid <> ALL($2::text[])`,
    [bookId, presentUids.length ? presentUids : ['']],
  );
  for (const c of toUpsert) await upsertCardavContact(bookId, userId, c);
  const changedBooks = new Set([bookId]);
  for (const m of toMerge) {
    const mergedBook = await mergeIntoExisting(m.id, m.contact, mergedIds.has(m.id));
    mergedIds.add(m.id);
    if (mergedBook) changedBooks.add(mergedBook);
  }

  for (const id of changedBooks) {
    await query(
      "UPDATE address_books SET sync_token = gen_random_uuid()::text, updated_at = NOW() WHERE id = $1",
      [id],
    );
  }
  return { bookId, count: presentUids.length };
}

export async function syncUser(userId) {
  const config = await getCardavConfig(userId);
  if (!config?.serverUrl) return { ok: false, error: 'not connected' };
  if (syncing.has(userId)) return { ok: false, error: 'A sync is already in progress' };
  syncing.add(userId);
  const policy = await getConnectionPolicy();
  const allowPrivate = policy.allowPrivateHosts;
  const creds = { username: config.username, password: decrypt(config.password), allowPrivate };

  try {
    const books = await discoverAddressBooks({ serverUrl: config.serverUrl, ...creds });
    let contactCount = 0;
    const seenUrls = [];
    const mergedIds = new Set();
    for (const book of books) {
      const { count } = await syncBook(userId, book, config.dupMode || 'separate', creds, mergedIds);
      contactCount += count;
      seenUrls.push(book.url);
    }
    // Prune local CardDAV books whose remote collection disappeared (cascades to contacts).
    await query(
      `DELETE FROM address_books
       WHERE user_id = $1 AND source = 'carddav' AND external_url <> ALL($2::text[])`,
      [userId, seenUrls.length ? seenUrls : ['']],
    );
    await saveCardavConfig(userId, {
      lastSyncAt: new Date().toISOString(),
      lastError: null, bookCount: books.length, contactCount,
    });
    return { ok: true, bookCount: books.length, contactCount };
  } catch (err) {
    await saveCardavConfig(userId, { lastError: err.message, lastSyncAt: new Date().toISOString() });
    return { ok: false, error: err.message };
  } finally {
    syncing.delete(userId);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

export function scheduleCardavUser(userId, intervalMin) {
  stopCardavUser(userId);
  const min = Math.max(15, Math.min(1440, parseInt(intervalMin) || DEFAULT_INTERVAL_MIN));
  const id = setInterval(() => {
    syncUser(userId).catch(e => console.warn(`CardDAV sync failed for ${userId}:`, e.message));
  }, min * 60 * 1000);
  timers.set(userId, id);
}

export function stopCardavUser(userId) {
  const id = timers.get(userId);
  if (id) { clearInterval(id); timers.delete(userId); }
}

export async function startCardavScheduler() {
  try {
    const rows = await query("SELECT user_id, config FROM user_integrations WHERE provider = 'carddav'");
    for (const row of rows.rows) {
      if (row.config?.serverUrl) scheduleCardavUser(row.user_id, row.config?.intervalMin);
    }
    if (rows.rows.length) console.log(`CardDAV: scheduled sync for ${rows.rows.length} account(s)`);
  } catch (err) {
    console.warn('CardDAV scheduler start failed:', err.message);
  }
}

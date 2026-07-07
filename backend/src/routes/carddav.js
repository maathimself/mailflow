// CardDAV server — supports Apple Contacts, Thunderbird, DAVx5 / Android.
// Protocol: RFC 6352 (CardDAV), RFC 4918 (WebDAV).
// Auth: HTTP Basic against the MailFlow users table via bcryptjs.
//
// URL layout:
//   /.well-known/carddav           → 301 to /carddav/
//   /carddav/                      → OPTIONS, PROPFIND (discovery)
//   /carddav/{userId}/             → PROPFIND (principal + addressbook-home-set)
//   /carddav/{userId}/{bookId}/    → PROPFIND, REPORT (list/sync VCards)
//   /carddav/{userId}/{bookId}/{uid}.vcf → GET, PUT, DELETE

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { query } from '../services/db.js';
import { parseVCard } from '../utils/vcard.js';
import { authLimiterConfig } from '../services/authLimiter.js';
import { consume as rlConsume } from '../services/rateLimiter.js';
import { logAuthEvent } from '../services/authEvents.js';

const router = Router();

// Precomputed valid hash so a non-existent username takes the same time as a real
// one (constant-time — closes the username-enumeration timing oracle).
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('mailflow-timing-equalizer', 12);

// ── Rate limiting (shared config, separate buckets from login) ────────────────

const cardavBuckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of cardavBuckets) {
    if (now > bucket.resetAt) cardavBuckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

// CardDAV clients can issue dozens of requests per sync (PROPFIND + per-card GET/PUT).
// Use a generous per-IP ceiling independent of the login rate-limit config.
const CARDDAV_MAX_REQUESTS = 500;

function cardavRateLimit(req, res, next) {
  const { windowMs } = authLimiterConfig;
  const key = req.ip;
  const now = Date.now();
  const bucket = cardavBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    cardavBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return next();
  }
  if (bucket.count >= CARDDAV_MAX_REQUESTS) {
    res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
    return res.status(429).end();
  }
  bucket.count++;
  next();
}

// ── HTTP Basic authentication middleware ──────────────────────────────────────

async function cardavAuth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="MailFlow CardDAV"');
    return res.status(401).end();
  }

  const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  const colon   = decoded.indexOf(':');
  if (colon < 0) {
    res.setHeader('WWW-Authenticate', 'Basic realm="MailFlow CardDAV"');
    return res.status(401).end();
  }

  const username = decoded.slice(0, colon);
  const password = decoded.slice(colon + 1);

  try {
    const r = await query(
      'SELECT id, password_hash, totp_enabled FROM users WHERE username = $1',
      [username]
    );
    const user = r.rows[0];
    // Count CardDAV auth failures against the same per-IP limiter as login and log
    // them to the audit trail — brute-force/visibility parity with the login path.
    const authFail = async () => {
      const { limited } = await rlConsume(`auth:${req.ip}`, authLimiterConfig.maxRequests, authLimiterConfig.windowMs);
      logAuthEvent('carddav_auth_fail', { username: username || null, ip: req.ip, success: false });
      res.setHeader('WWW-Authenticate', 'Basic realm="MailFlow CardDAV"');
      return res.status(limited ? 429 : 401).end();
    };
    if (!user || !user.password_hash) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH); // constant-time vs the real path
      return authFail();
    }
    // Verify password before checking totp_enabled so the response is
    // indistinguishable regardless of whether the account exists or has 2FA.
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return authFail();
    // CardDAV HTTP Basic cannot satisfy a TOTP second factor.
    // Block access entirely for accounts with 2FA enabled until app-specific
    // passwords are implemented. Return 403 (not 401) so clients don't retry.
    if (user.totp_enabled) {
      return res.status(403)
        .set('Content-Type', 'text/plain')
        .send('Two-factor authentication is enabled. CardDAV requires an app-specific password.');
    }
    req.cardavUserId = user.id;
    next();
  } catch (err) {
    console.error('CardDAV auth error:', err);
    res.status(500).end();
  }
}

router.use(cardavRateLimit);
router.use(cardavAuth);

// ── XML helpers ───────────────────────────────────────────────────────────────

const DAV_NS     = 'DAV:';
const CARD_NS    = 'urn:ietf:params:xml:ns:carddav';
const CDAV_NS    = 'http://calendarserver.org/ns/';

function xmlHeader() {
  return '<?xml version="1.0" encoding="UTF-8"?>';
}

function multistatus(responses) {
  return [
    xmlHeader(),
    `<D:multistatus xmlns:D="${DAV_NS}" xmlns:C="${CARD_NS}" xmlns:CS="${CDAV_NS}">`,
    ...responses,
    '</D:multistatus>',
  ].join('');
}

function response(href, propstats) {
  return [
    '<D:response>',
    `<D:href>${xmlEscape(href)}</D:href>`,
    ...propstats,
    '</D:response>',
  ].join('');
}

function propstat(props, status) {
  return [
    '<D:propstat>',
    '<D:prop>',
    ...props,
    '</D:prop>',
    `<D:status>HTTP/1.1 ${status}</D:status>`,
    '</D:propstat>',
  ].join('');
}

function xmlEscape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sendXml(res, status, xml) {
  res.status(status)
     .setHeader('Content-Type', 'application/xml; charset=utf-8')
     .send(xml);
}

// Collect the request body as a string by reading the raw stream.
// We do not go through express.json/text — CardDAV uses custom content types.
function rawBody(req) {
  return new Promise((resolve, reject) => {
    // If a body parser already collected it (unlikely here), use it.
    if (typeof req.body === 'string') return resolve(req.body);
    if (Buffer.isBuffer(req.body)) return resolve(req.body.toString('utf8'));
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ── OPTIONS (broadcast CardDAV support) ──────────────────────────────────────

router.options('*', (req, res) => {
  res.set({
    'Allow': 'OPTIONS, GET, PUT, DELETE, PROPFIND, REPORT',
    'DAV': '1, 2, 3, addressbook',
  }).status(200).end();
});

// ── PROPFIND / (root discovery) ───────────────────────────────────────────────

router.propfind('/', async (req, res) => {
  const userId = req.cardavUserId;
  const principalPath = `/carddav/${userId}/`;

  const xml = multistatus([
    response('/carddav/', [
      propstat([
        '<D:resourcetype><D:collection/></D:resourcetype>',
        `<D:current-user-principal><D:href>${xmlEscape(principalPath)}</D:href></D:current-user-principal>`,
      ], '200 OK'),
    ]),
  ]);
  sendXml(res, 207, xml);
});

// ── PROPFIND /{userId}/ (principal) ──────────────────────────────────────────

router.propfind('/:userId/', async (req, res) => {
  const userId = req.cardavUserId;
  if (req.params.userId !== userId) return res.status(403).end();

  const principalPath  = `/carddav/${userId}/`;

  const r = await query(
    'SELECT id FROM address_books WHERE user_id = $1 ORDER BY created_at LIMIT 1',
    [userId]
  );
  const bookId   = r.rows[0]?.id;
  const homePath = bookId ? `/carddav/${userId}/${bookId}/` : principalPath;

  const xml = multistatus([
    response(principalPath, [
      propstat([
        '<D:resourcetype><D:principal/><D:collection/></D:resourcetype>',
        `<D:displayname>${xmlEscape(userId)}</D:displayname>`,
        `<D:principal-URL><D:href>${xmlEscape(principalPath)}</D:href></D:principal-URL>`,
        `<C:addressbook-home-set><D:href>${xmlEscape(homePath)}</D:href></C:addressbook-home-set>`,
        `<D:current-user-principal><D:href>${xmlEscape(principalPath)}</D:href></D:current-user-principal>`,
      ], '200 OK'),
    ]),
  ]);
  sendXml(res, 207, xml);
});

// ── PROPFIND /{userId}/{bookId}/ (address book) ───────────────────────────────

router.propfind('/:userId/:bookId/', async (req, res) => {
  const userId = req.cardavUserId;
  if (req.params.userId !== userId) return res.status(403).end();

  const depth = req.headers['depth'] || '0';

  const bookResult = await query(
    'SELECT * FROM address_books WHERE id = $1 AND user_id = $2',
    [req.params.bookId, userId]
  );
  if (!bookResult.rows.length) return res.status(404).end();
  const book = bookResult.rows[0];

  const bookPath = `/carddav/${userId}/${book.id}/`;

  const bookResponse = response(bookPath, [
    propstat([
      `<D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>`,
      `<D:displayname>${xmlEscape(book.name)}</D:displayname>`,
      `<D:sync-token>${xmlEscape(book.sync_token)}</D:sync-token>`,
      `<CS:getctag>${xmlEscape(book.sync_token)}</CS:getctag>`,
    ], '200 OK'),
  ]);

  if (depth === '0') {
    return sendXml(res, 207, multistatus([bookResponse]));
  }

  // Depth: 1 — list all VCards in the book.
  const contacts = await query(
    'SELECT uid, etag FROM contacts WHERE address_book_id = $1',
    [book.id]
  );

  const cardResponses = contacts.rows.map(c =>
    response(`${bookPath}${encodeURIComponent(c.uid)}.vcf`, [
      propstat([
        '<D:resourcetype/>',
        `<D:getetag>"${xmlEscape(c.etag)}"</D:getetag>`,
        '<D:getcontenttype>text/vcard;charset=utf-8</D:getcontenttype>',
      ], '200 OK'),
    ])
  );

  sendXml(res, 207, multistatus([bookResponse, ...cardResponses]));
});

// ── REPORT /{userId}/{bookId}/ (addressbook-query / sync-collection) ──────────

router.report('/:userId/:bookId/', async (req, res) => {
  const userId = req.cardavUserId;
  if (req.params.userId !== userId) return res.status(403).end();

  const bookResult = await query(
    'SELECT * FROM address_books WHERE id = $1 AND user_id = $2',
    [req.params.bookId, userId]
  );
  if (!bookResult.rows.length) return res.status(404).end();
  const book = bookResult.rows[0];
  const bookPath = `/carddav/${userId}/${book.id}/`;

  const body = await rawBody(req);
  const isSyncCollection = body.includes('sync-collection');

  // Fetch all contacts with their vCard data.
  const contacts = await query(
    'SELECT uid, vcard, etag FROM contacts WHERE address_book_id = $1',
    [book.id]
  );

  const cardResponses = contacts.rows.map(c => {
    const href = `${bookPath}${encodeURIComponent(c.uid)}.vcf`;
    return response(href, [
      propstat([
        '<D:resourcetype/>',
        `<D:getetag>"${xmlEscape(c.etag)}"</D:getetag>`,
        '<D:getcontenttype>text/vcard;charset=utf-8</D:getcontenttype>',
        `<C:address-data>${xmlEscape(c.vcard || '')}</C:address-data>`,
      ], '200 OK'),
    ]);
  });

  if (isSyncCollection) {
    const xml = [
      xmlHeader(),
      `<D:multistatus xmlns:D="${DAV_NS}" xmlns:C="${CARD_NS}">`,
      ...cardResponses,
      `<D:sync-token>${xmlEscape(book.sync_token)}</D:sync-token>`,
      '</D:multistatus>',
    ].join('');
    return sendXml(res, 207, xml);
  }

  sendXml(res, 207, multistatus(cardResponses));
});

// ── GET /{userId}/{bookId}/{uid}.vcf ─────────────────────────────────────────

router.get('/:userId/:bookId/:filename', async (req, res) => {
  const userId = req.cardavUserId;
  if (req.params.userId !== userId) return res.status(403).end();

  const uid = req.params.filename.replace(/\.vcf$/i, '');

  const result = await query(
    `SELECT c.vcard, c.etag FROM contacts c
     JOIN address_books ab ON ab.id = c.address_book_id
     WHERE ab.id = $1 AND ab.user_id = $2 AND c.uid = $3`,
    [req.params.bookId, userId, uid]
  );
  if (!result.rows.length) return res.status(404).end();

  const { vcard, etag } = result.rows[0];
  res.set({
    'Content-Type': 'text/vcard;charset=utf-8',
    'ETag': `"${etag}"`,
  }).send(vcard);
});

// ── PUT /{userId}/{bookId}/{uid}.vcf (create or update) ──────────────────────

router.put('/:userId/:bookId/:filename', async (req, res) => {
  const userId = req.cardavUserId;
  if (req.params.userId !== userId) return res.status(403).end();

  const uid  = req.params.filename.replace(/\.vcf$/i, '');
  const body = await rawBody(req);
  if (!body.trim()) return res.status(400).end();

  const parsed = parseVCard(body);
  const vcard  = body; // store what the client sent verbatim
  const etag   = crypto.createHash('md5').update(vcard).digest('hex');

  const primaryEmail = parsed.emails[0]?.value?.toLowerCase() || null;

  try {
    const bookResult = await query(
      'SELECT id FROM address_books WHERE id = $1 AND user_id = $2',
      [req.params.bookId, userId]
    );
    if (!bookResult.rows.length) return res.status(404).end();
    const bookId = bookResult.rows[0].id;

    const existing = await query(
      'SELECT id, etag FROM contacts WHERE address_book_id = $1 AND uid = $2',
      [bookId, uid]
    );

    if (existing.rows.length) {
      // Enforce If-Match precondition (RFC 6352 §6.3.2)
      const ifMatch = req.headers['if-match'];
      if (ifMatch && ifMatch !== '*') {
        const clientEtag = ifMatch.replace(/^"(.*)"$/, '$1');
        if (clientEtag !== existing.rows[0].etag) return res.status(412).end();
      }
      // Update
      await query(`
        UPDATE contacts SET
          vcard = $1, etag = $2,
          display_name = $3, first_name = $4, last_name = $5,
          primary_email = $6, emails = $7, phones = $8,
          organization = $9, notes = $10, photo_data = $11,
          is_auto = false, updated_at = NOW()
        WHERE id = $12
      `, [
        vcard, etag,
        parsed.displayName, parsed.firstName, parsed.lastName,
        primaryEmail,
        JSON.stringify(parsed.emails), JSON.stringify(parsed.phones),
        parsed.organization, parsed.notes, parsed.photoData,
        existing.rows[0].id,
      ]);
      await query(
        'UPDATE address_books SET sync_token = gen_random_uuid()::text, updated_at = NOW() WHERE id = $1',
        [bookId]
      );
      res.set('ETag', `"${etag}"`).status(204).end();
    } else {
      // Create
      await query(`
        INSERT INTO contacts (
          address_book_id, user_id, uid, vcard, etag,
          display_name, first_name, last_name, primary_email,
          emails, phones, organization, notes, photo_data, is_auto
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, false)
      `, [
        bookId, userId, uid, vcard, etag,
        parsed.displayName, parsed.firstName, parsed.lastName,
        primaryEmail,
        JSON.stringify(parsed.emails), JSON.stringify(parsed.phones),
        parsed.organization, parsed.notes, parsed.photoData,
      ]);
      await query(
        'UPDATE address_books SET sync_token = gen_random_uuid()::text, updated_at = NOW() WHERE id = $1',
        [bookId]
      );
      res.set('ETag', `"${etag}"`).status(201).end();
    }
  } catch (err) {
    if (err.code === '23505') return res.status(409).end(); // unique conflict
    console.error('CardDAV PUT error:', err);
    res.status(500).end();
  }
});

// ── DELETE /{userId}/{bookId}/{uid}.vcf ──────────────────────────────────────

router.delete('/:userId/:bookId/:filename', async (req, res) => {
  const userId = req.cardavUserId;
  if (req.params.userId !== userId) return res.status(403).end();

  const uid = req.params.filename.replace(/\.vcf$/i, '');

  try {
    const result = await query(
      `DELETE FROM contacts
       USING address_books
       WHERE contacts.address_book_id = address_books.id
         AND address_books.id = $1
         AND address_books.user_id = $2
         AND contacts.uid = $3
       RETURNING address_books.id AS book_id`,
      [req.params.bookId, userId, uid]
    );
    if (!result.rows.length) return res.status(404).end();
    await query(
      'UPDATE address_books SET sync_token = gen_random_uuid()::text, updated_at = NOW() WHERE id = $1',
      [result.rows[0].book_id]
    );
    res.status(204).end();
  } catch (err) {
    console.error('CardDAV DELETE error:', err);
    res.status(500).end();
  }
});

export default router;

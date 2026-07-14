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
import { query } from '../services/db.js';
import { authLimiterConfig } from '../services/authLimiter.js';
import { consume as rlConsume } from '../services/rateLimiter.js';
import { logAuthEvent } from '../services/authEvents.js';
import { xmlEscape } from '../services/carddavXml.js';
import {
  CARDDAV_CONTACT_ERROR_STATUS,
  createContactFromVCard,
  deleteContactFromVCard,
  replaceContactFromVCard,
} from '../services/carddavContactService.js';
import { presentedEtag, presentedVCard } from '../utils/vcardProperties.js';

// Select the modeled columns + the retained remote vCard so a mapped contact can be
// served losslessly (see presentedVCard). local_contact_id maps at most one active
// remote object per contact, so this stays one row per contact.
const CONTACT_READ_COLUMNS = `
  c.uid, c.display_name, c.first_name, c.last_name, c.emails, c.phones,
  c.organization, c.notes, c.photo_data, c.additional_fields,
  c.vcard, c.etag, mapping.vcard AS mapping_vcard`;
const CONTACT_MAPPING_JOIN = `
  LEFT JOIN carddav_remote_objects mapping
    ON mapping.local_contact_id = c.id
   AND mapping.mapping_status <> 'pending_materialization'`;

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
const CARDDAV_MAX_BODY_BYTES = 1024 * 1024;

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
router.param('userId', (req, res, next, userId) => {
  if (userId !== req.cardavUserId) return res.status(403).end();
  next();
});

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

function sendXml(res, status, xml) {
  res.status(status)
     .setHeader('Content-Type', 'application/xml; charset=utf-8')
     .send(xml);
}

function bodyTooLargeError() {
  return Object.assign(new Error('CardDAV request body exceeds 1 MiB'), {
    code: 'ERR_CARDDAV_BODY_TOO_LARGE',
  });
}

function requestAbortedError() {
  return Object.assign(new Error('CardDAV request body ended prematurely'), {
    code: 'ERR_CARDDAV_REQUEST_ABORTED',
  });
}

// Collect the request body as bytes before converting it to UTF-8.
// We do not go through express.json/text — CardDAV uses custom content types.
export function readRawBody(req, { maxBytes = Infinity } = {}) {
  return new Promise((resolve, reject) => {
    // If a body parser already collected it (unlikely here), use it.
    if (typeof req.body === 'string') {
      return Buffer.byteLength(req.body, 'utf8') > maxBytes
        ? reject(bodyTooLargeError())
        : resolve(req.body);
    }
    if (Buffer.isBuffer(req.body)) {
      return req.body.length > maxBytes
        ? reject(bodyTooLargeError())
        : resolve(req.body.toString('utf8'));
    }

    const chunks = [];
    let total = 0;
    let state = 'collecting';
    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('close', onClose);
      req.removeListener('aborted', onAborted);
    };
    const rejectAndDrain = (error, resume) => {
      if (state !== 'collecting') return;
      state = 'draining';
      req.removeListener('data', onData);
      req.removeListener('aborted', onAborted);
      reject(error);
      if (resume) req.resume();
    };
    const onData = chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (total + buffer.length > maxBytes) {
        rejectAndDrain(bodyTooLargeError(), true);
        return;
      }
      total += buffer.length;
      chunks.push(buffer);
    };
    const onEnd = () => {
      const shouldResolve = state === 'collecting';
      state = 'settled';
      cleanup();
      if (shouldResolve) resolve(Buffer.concat(chunks, total).toString('utf8'));
    };
    const onError = error => {
      if (state === 'draining') return;
      state = 'settled';
      cleanup();
      reject(error);
    };
    const onClose = () => {
      const shouldReject = state === 'collecting';
      state = 'settled';
      cleanup();
      if (shouldReject) reject(requestAbortedError());
    };
    const onAborted = () => rejectAndDrain(requestAbortedError(), false);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
    req.on('aborted', onAborted);
  });
}

function ifMatchEtag(req) {
  const value = req.headers['if-match'];
  return value && value !== '*' ? value.replace(/^"(.*)"$/, '$1') : null;
}

function requiresAbsentResource(req) {
  return String(req.headers['if-none-match'] || '').trim() === '*';
}

// Read a served contact (modeled columns + retained mapping vCard) so the route can
// serve, and validate preconditions against, the presented representation.
async function readServedContact(bookId, userId, uid) {
  const { rows: [contact] } = await query(
    `SELECT ${CONTACT_READ_COLUMNS}
     FROM contacts c
     JOIN address_books ab ON ab.id = c.address_book_id
     ${CONTACT_MAPPING_JOIN}
     WHERE ab.id = $1 AND ab.user_id = $2 AND c.uid = $3`,
    [bookId, userId, uid],
  );
  return contact || null;
}

// The strong validator MailFlow's CardDAV server exposes, derived from the presented
// document, so GET/REPORT/PROPFIND all quote the same ETag and mutations
// validate against it.
function servedEtag(contact) {
  return `"${presentedEtag(contact)}"`;
}

// A mapped contact (retained upstream document present) — its mutations delegate to the
// shared external write path and must be conditional.
function isMappedContact(contact) {
  return Boolean(contact?.mapping_vcard);
}

// RFC 7232 §3.1/§3.2 + RFC 6352 §6.3.2 preconditions against the SERVED ETag,
// centralized so every mutation path fences on the same validator GET exposes. Returns
// the HTTP status to send, or null to proceed.
function preconditionFailure(req, contact) {
  if (requiresAbsentResource(req)) return contact ? 412 : null;
  if (!contact) return null;
  const clientEtag = ifMatchEtag(req);
  if (isMappedContact(contact)) {
    // A mapped mutation REQUIRES a REAL strong validator. ifMatchEtag returns
    // null for absent, `*`, and empty If-Match — all of which lack freshness and would let
    // a client authoritatively overwrite the upstream document — so 428 (retry with a real
    // If-Match). A real ETag is compared strongly (412 on mismatch).
    if (!clientEtag) return 428;
    return clientEtag !== presentedEtag(contact) ? 412 : null;
  }
  return clientEtag && clientEtag !== presentedEtag(contact) ? 412 : null;
}

function carddavMutationError(res, err, operation) {
  const status = {
    ...CARDDAV_CONTACT_ERROR_STATUS,
    ERR_CARDDAV_BODY_TOO_LARGE: 413,
    ERR_CARDDAV_REQUEST_ABORTED: 400,
    ERR_LOCAL_ETAG_MISMATCH: 412,
    ERR_LOCAL_PRECONDITION_FAILED: 412,
  }[err.code] ?? (Number.isInteger(err.status) ? err.status : null);
  if (status) return res.status(status).end();
  console.error(`CardDAV ${operation} error:`, err);
  return res.status(500).end();
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

  // Depth: 1 — list all VCards in the book. Quote the PRESENTED ETag so
  // PROPFIND, REPORT, and GET all expose the same strong validator.
  const contacts = await query(
    `SELECT ${CONTACT_READ_COLUMNS} FROM contacts c ${CONTACT_MAPPING_JOIN}
     WHERE c.address_book_id = $1`,
    [book.id]
  );

  const cardResponses = contacts.rows.map(c =>
    response(`${bookPath}${encodeURIComponent(c.uid)}.vcf`, [
      propstat([
        '<D:resourcetype/>',
        `<D:getetag>${servedEtag(c)}</D:getetag>`,
        '<D:getcontenttype>text/vcard;charset=utf-8</D:getcontenttype>',
      ], '200 OK'),
    ])
  );

  sendXml(res, 207, multistatus([bookResponse, ...cardResponses]));
});

// ── REPORT /{userId}/{bookId}/ (addressbook-query / sync-collection) ──────────

router.report('/:userId/:bookId/', async (req, res) => {
  const userId = req.cardavUserId;

  const bookResult = await query(
    'SELECT * FROM address_books WHERE id = $1 AND user_id = $2',
    [req.params.bookId, userId]
  );
  if (!bookResult.rows.length) return res.status(404).end();
  const book = bookResult.rows[0];
  const bookPath = `/carddav/${userId}/${book.id}/`;

  // Bound the REPORT body like PUT — the handler only tests it for a marker
  // string, so an unbounded body would be a memory-exhaustion vector (413).
  let body;
  try {
    body = await readRawBody(req, { maxBytes: CARDDAV_MAX_BODY_BYTES });
  } catch (err) {
    return carddavMutationError(res, err, 'REPORT');
  }
  const isSyncCollection = body.includes('sync-collection');

  // Fetch all contacts with their vCard data (retained remote vCard included so a
  // mapped contact is served losslessly).
  const contacts = await query(
    `SELECT ${CONTACT_READ_COLUMNS}
     FROM contacts c ${CONTACT_MAPPING_JOIN}
     WHERE c.address_book_id = $1`,
    [book.id]
  );

  const cardResponses = contacts.rows.map(c => {
    const href = `${bookPath}${encodeURIComponent(c.uid)}.vcf`;
    return response(href, [
      propstat([
        '<D:resourcetype/>',
        `<D:getetag>${servedEtag(c)}</D:getetag>`,
        '<D:getcontenttype>text/vcard;charset=utf-8</D:getcontenttype>',
        `<C:address-data>${xmlEscape(presentedVCard(c) || '')}</C:address-data>`,
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

  const uid = req.params.filename.replace(/\.vcf$/i, '');

  const contact = await readServedContact(req.params.bookId, userId, uid);
  if (!contact) return res.status(404).end();

  res.set({
    'Content-Type': 'text/vcard;charset=utf-8',
    'ETag': servedEtag(contact),
  }).send(presentedVCard(contact));
});

// ── PUT /{userId}/{bookId}/{uid}.vcf (create or update) ──────────────────────

router.put('/:userId/:bookId/:filename', async (req, res) => {
  const userId = req.cardavUserId;

  const uid  = req.params.filename.replace(/\.vcf$/i, '');

  try {
    const body = await readRawBody(req, { maxBytes: CARDDAV_MAX_BODY_BYTES });
    if (!body.trim()) return res.status(400).end();
    const bookResult = await query(
      'SELECT id FROM address_books WHERE id = $1 AND user_id = $2',
      [req.params.bookId, userId]
    );
    if (!bookResult.rows.length) return res.status(404).end();
    const bookId = bookResult.rows[0].id;

    const existing = await readServedContact(bookId, userId, uid);
    const failure = preconditionFailure(req, existing);
    if (failure) return res.status(failure).end();

    if (existing) {
      await replaceContactFromVCard(userId, {
        localAddressBookId: bookId,
        uid,
        rawVCard: body,
        expectedLocalEtag: existing.etag,
      });
      const served = await readServedContact(bookId, userId, uid);
      if (served) res.set('ETag', servedEtag(served));
      res.status(204).end();
    } else {
      await createContactFromVCard(userId, {
        localAddressBookId: bookId,
        uid,
        rawVCard: body,
        ...(requiresAbsentResource(req) ? { expectedAbsent: true } : {}),
      });
      const served = await readServedContact(bookId, userId, uid);
      if (served) res.set('ETag', servedEtag(served));
      res.status(201).end();
    }
  } catch (err) {
    carddavMutationError(res, err, 'PUT');
  }
});

// ── DELETE /{userId}/{bookId}/{uid}.vcf ──────────────────────────────────────

router.delete('/:userId/:bookId/:filename', async (req, res) => {
  const userId = req.cardavUserId;

  const uid = req.params.filename.replace(/\.vcf$/i, '');

  try {
    const bookResult = await query(
      'SELECT id FROM address_books WHERE id = $1 AND user_id = $2',
      [req.params.bookId, userId]
    );
    if (!bookResult.rows.length) return res.status(404).end();
    const bookId = bookResult.rows[0].id;
    const existing = await readServedContact(bookId, userId, uid);
    if (!existing) return res.status(404).end();
    const failure = preconditionFailure(req, existing);
    if (failure) return res.status(failure).end();
    await deleteContactFromVCard(userId, {
      localAddressBookId: bookId,
      uid,
      expectedLocalEtag: existing.etag,
    });
    res.status(204).end();
  } catch (err) {
    carddavMutationError(res, err, 'DELETE');
  }
});

export default router;

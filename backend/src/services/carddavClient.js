// Minimal CardDAV *client* — discovers address books on a remote server (e.g.
// Nextcloud) and pulls vCards. One-way/read-only: we never write back.
//
// Flow: current-user-principal -> addressbook-home-set -> enumerate collections
// -> addressbook-query REPORT for each book's vCards, or, where the server refuses that
// report (Google, #503), a PROPFIND listing plus addressbook-multiget. Uses native fetch with the
// WebDAV verbs PROPFIND/REPORT and HTTP Basic auth. Host is SSRF-validated up
// front (reusing the same policy IMAP/SMTP hosts use).

import { XMLParser } from 'fast-xml-parser';
import { validateHost } from './hostValidation.js';
import { safeFetch } from './safeFetch.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,   // <d:response> -> response, so parsing is namespace-agnostic
  trimValues: false,      // preserve vCard line structure inside <address-data>
  // Large CardDAV REPORTs can exceed fast-xml-parser's 1000-expansion default.
  // Raise it generously while preserving the previous depth setting.
  processEntities: { maxTotalExpansions: 10_000_000, maxExpansionDepth: 10 },
});

const toArray = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);

function basicAuth(username, password) {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

async function assertHostAllowed(url, allowPrivate) {
  let hostname;
  try { hostname = new URL(url).hostname; }
  catch { throw new Error('Invalid server URL'); }
  const err = await validateHost(hostname, { allowPrivate });
  if (err) throw new Error(err);
}

async function dav(method, url, { username, password, depth, body, allowPrivate = false } = {}) {
  // Re-validate on every request: hrefs returned by the server (principal, home
  // set, book URLs) are attacker-influenced and could point at internal hosts.
  await assertHostAllowed(url, allowPrivate);
  const headers = {
    Authorization: basicAuth(username, password),
    'Content-Type': 'application/xml; charset=utf-8',
  };
  if (depth != null) headers.Depth = String(depth);
  let res;
  try {
    // safeFetch validates every redirect hop's IP (well-known discovery relies on
    // the server's 301 redirect), honouring the admin private-host policy.
    res = await safeFetch(url, { method, headers, body, redirect: 'follow', signal: AbortSignal.timeout(30000) }, { allowPrivate });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error('CardDAV server did not respond (timed out)', { cause: err });
    throw new Error(`Could not reach the CardDAV server: ${err.message}`, { cause: err });
  }
  if (res.status === 401) throw new Error('Authentication failed — check the username and app password');
  if (!res.ok && res.status !== 207) {
    const err = new Error(`CardDAV request failed (${res.status} ${res.statusText})`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

// Merge the <prop> blocks from every 2xx propstat of a <response> into one object.
// A propstat carrying a non-2xx status (e.g. 404 for unsupported props) is skipped;
// a propstat with no status line at all is treated as usable.
function propsOf(response) {
  const merged = {};
  for (const ps of toArray(response.propstat)) {
    const status = typeof ps.status === 'string' ? ps.status : '';
    if (status && !/\b2\d\d\b/.test(status)) continue;
    Object.assign(merged, ps.prop || {});
  }
  return merged;
}

function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'object' && '#text' in node) return String(node['#text']);
  return '';
}

// fast-xml-parser decodes named XML entities (&amp; -> &) but leaves numeric
// character references (&#13;, &#xE9;) as literal text. Nextcloud/SabreDAV encodes
// each vCard line's trailing CR as &#13; inside <address-data> so the CRLF endings
// survive XML line-ending normalization; without decoding, every parsed field keeps
// a literal "&#13;" (and an empty property renders as just "&#13;"). Decode decimal
// and hex references back to their characters — the vCard parser then handles the
// restored CR/LF normally. Named entities are left for the XML parser to resolve.
function decodeXmlCharRefs(str) {
  return str.replace(/&#([xX][0-9a-fA-F]+|\d+);/g, (match, code) => {
    const cp = (code[0] === 'x' || code[0] === 'X')
      ? parseInt(code.slice(1), 16)
      : parseInt(code, 10);
    // Reject out-of-range and surrogate code points; leave those references as-is.
    if (!Number.isFinite(cp) || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return match;
    try { return String.fromCodePoint(cp); }
    catch { return match; }
  });
}

// Resolve an href (often an absolute path) against the request URL's origin.
function absolute(href, baseUrl) {
  try { return new URL(href, baseUrl).href; }
  catch { return href; }
}

// Pure: pull a single href-valued property out of a PROPFIND multistatus, by its
// namespace-stripped local name (e.g. 'current-user-principal'). Exported for testing.
export function extractHref(xmlText, key, baseUrl) {
  const xml = parser.parse(xmlText);
  const response = toArray(xml?.multistatus?.response)[0];
  if (!response) return null;
  const val = propsOf(response)[key];
  const href = val?.href ?? val;
  const text = textOf(href) || (typeof href === 'string' ? href : '');
  return text ? absolute(text, baseUrl) : null;
}

// PROPFIND for a single href-valued property. `key` is the expected local name in
// the response (passed explicitly rather than derived from the request markup).
async function propfindHref(url, propXml, key, creds) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><prop>${propXml}</prop></propfind>`;
  return extractHref(await dav('PROPFIND', url, { ...creds, depth: 0, body }), key, url);
}

// Find the user's principal URL. Tries the given URL, then RFC 6764 well-known
// discovery (Nextcloud users usually enter just the base URL, which 301-redirects
// from /.well-known/carddav to the DAV context — fetch follows that automatically).
async function resolvePrincipal(serverUrl, creds) {
  const origin = new URL(serverUrl).origin;
  const candidates = [serverUrl, `${origin}/.well-known/carddav`];
  let lastErr;
  for (const base of candidates) {
    try {
      const principal = await propfindHref(base, '<current-user-principal/>', 'current-user-principal', creds);
      if (principal) return principal;
    } catch (err) {
      if (/Authentication failed/.test(err.message)) throw err; // wrong creds — stop trying
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return serverUrl; // some servers expose the home set directly at the given URL
}

// Discover every address book on the server for these credentials.
// Returns [{ url, displayName }].
export async function discoverAddressBooks({ serverUrl, username, password, allowPrivate = false }) {
  await assertHostAllowed(serverUrl, allowPrivate);
  const creds = { username, password, allowPrivate };

  const principal = await resolvePrincipal(serverUrl, creds);
  const homeSet = await propfindHref(principal, '<C:addressbook-home-set/>', 'addressbook-home-set', creds)
    || principal;

  // Enumerate collections under the home set (Depth: 1).
  const body = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:" xmlns:cs="http://calendarserver.org/ns/"><prop>
  <resourcetype/><displayname/><cs:getctag/></prop></propfind>`;
  const xmlText = await dav('PROPFIND', homeSet, { ...creds, depth: 1, body });
  const books = parseAddressBooks(xmlText, homeSet);
  if (!books.length) throw new Error('No address books found for this account');
  return books;
}

// Pure: extract address-book collections from a PROPFIND multistatus. Exported
// for testing. Returns [{ url, displayName }].
export function parseAddressBooks(xmlText, baseUrl) {
  const xml = parser.parse(xmlText);
  const books = [];
  for (const response of toArray(xml?.multistatus?.response)) {
    const props = propsOf(response);
    const rt = props.resourcetype || {};
    if (!('addressbook' in rt)) continue; // only address book collections
    const href = textOf(response.href) || response.href;
    if (!href) continue;
    books.push({
      url: absolute(href, baseUrl),
      displayName: textOf(props.displayname) || 'Contacts',
    });
  }
  return books;
}

// Statuses meaning "this server does not do that report" rather than a failure the fallback
// could not fix (auth is 401 and throws its own error; 404 means the book itself is gone).
const QUERY_UNSUPPORTED = new Set([400, 403, 405, 415, 422, 501]);
// Cards per addressbook-multiget, so a large book is fetched in bounded responses.
export const MULTIGET_BATCH = 100;

// Fetch every vCard in an address book. Returns [{ href, etag, vcard }].
//
// A filter-less addressbook-query REPORT fetches the whole book in one request and is what
// Nextcloud/SabreDAV and most servers answer, so it stays the first attempt. Google rejects it
// with 400; it implements only the listing-plus-multiget flow its CardDAV documentation
// describes (#503), so a refused query falls back to that.
export async function fetchAddressBookCards({ url, username, password, allowPrivate = false }) {
  await assertHostAllowed(url, allowPrivate);
  const creds = { username, password, allowPrivate };
  const body = `<?xml version="1.0" encoding="utf-8"?>
<C:addressbook-query xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><prop>
  <getetag/><C:address-data/></prop></C:addressbook-query>`;
  let xmlText;
  try {
    xmlText = await dav('REPORT', url, { ...creds, depth: 1, body });
  } catch (err) {
    if (!QUERY_UNSUPPORTED.has(err.status)) throw err;
    return fetchCardsByMultiget(url, creds);
  }
  return parseCards(xmlText, url);
}

const escapeXml = str => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function fetchCardsByMultiget(url, creds) {
  const listing = await dav('PROPFIND', url, { ...creds, depth: 1, body: `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:"><prop><getetag/><resourcetype/></prop></propfind>` });
  const hrefs = parseCardHrefs(listing, url);
  const cards = [];
  for (let i = 0; i < hrefs.length; i += MULTIGET_BATCH) {
    // No Depth header: RFC 6352 has servers ignore it on addressbook-multiget.
    const body = `<?xml version="1.0" encoding="utf-8"?>
<C:addressbook-multiget xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><prop>
  <getetag/><C:address-data/></prop>${hrefs.slice(i, i + MULTIGET_BATCH).map(h => `<href>${escapeXml(h)}</href>`).join('')}</C:addressbook-multiget>`;
    cards.push(...parseCards(await dav('REPORT', url, { ...creds, body }), url));
  }
  return cards;
}

// Pure: the hrefs of the cards in a Depth 1 PROPFIND of an address book, as the server wrote
// them (a multiget names cards by those hrefs). Skips the book's own entry and any
// sub-collection. Exported for testing.
export function parseCardHrefs(xmlText, bookUrl) {
  const xml = parser.parse(xmlText);
  const self = absolute(bookUrl, bookUrl).replace(/\/$/, '');
  const hrefs = [];
  for (const response of toArray(xml?.multistatus?.response)) {
    const href = (textOf(response.href) || '').trim();
    if (!href || absolute(href, bookUrl).replace(/\/$/, '') === self) continue;
    const type = propsOf(response).resourcetype;
    if (type && typeof type === 'object' && 'collection' in type) continue;
    hrefs.push(href);
  }
  return hrefs;
}

// Pure: extract vCards from an addressbook-query/REPORT multistatus. Exported for
// testing. Returns [{ href, etag, vcard }].
export function parseCards(xmlText, baseUrl) {
  const xml = parser.parse(xmlText);
  const responses = toArray(xml?.multistatus?.response);
  if (responses.some(response => /\b507\b/.test(textOf(response.status)))) {
    throw new Error('CardDAV server returned a truncated address book response');
  }
  const cards = [];
  for (const response of responses) {
    const props = propsOf(response);
    const vcard = decodeXmlCharRefs(textOf(props['address-data'])).trim();
    if (!vcard) continue; // collection self-entry or a non-vCard resource
    cards.push({
      href: absolute(textOf(response.href) || response.href, baseUrl),
      etag: (textOf(props.getetag) || '').replace(/"/g, ''),
      vcard,
    });
  }
  return cards;
}

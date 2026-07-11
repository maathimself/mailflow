// Minimal CardDAV *client* — discovers address books on a remote server (e.g.
// Nextcloud) and pulls vCards. One-way/read-only: we never write back.
//
// Flow: current-user-principal -> addressbook-home-set -> enumerate collections
// -> addressbook-query REPORT for each book's vCards. Uses native fetch with the
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
    throw new Error(`CardDAV request failed (${res.status} ${res.statusText})`);
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

// Fetch every vCard in an address book via a filter-less addressbook-query REPORT.
// Returns [{ href, etag, vcard }].
export async function fetchAddressBookCards({ url, username, password, allowPrivate = false }) {
  await assertHostAllowed(url, allowPrivate);
  const body = `<?xml version="1.0" encoding="utf-8"?>
<C:addressbook-query xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><prop>
  <getetag/><C:address-data/></prop></C:addressbook-query>`;
  const xmlText = await dav('REPORT', url, { username, password, depth: 1, body, allowPrivate });
  return parseCards(xmlText, url);
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
    const vcard = textOf(props['address-data']).trim();
    if (!vcard) continue; // collection self-entry or a non-vCard resource
    cards.push({
      href: absolute(textOf(response.href) || response.href, baseUrl),
      etag: (textOf(props.getetag) || '').replace(/"/g, ''),
      vcard,
    });
  }
  return cards;
}

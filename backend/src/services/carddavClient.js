// CardDAV client — discovers address books, pulls vCards, and performs
// conditional resource writes against a remote server (e.g. Nextcloud).
//
// Flow: current-user-principal -> addressbook-home-set -> enumerate collections
// -> addressbook-query REPORT for each book's vCards. This module owns CardDAV
// protocol logic; HTTP transport, response limits, and SSRF fencing live in
// carddavTransport.js.

import {
  CardDavError,
  createDavOperation,
  davRequest,
} from './carddavTransport.js';
import {
  CARDDAV_NS,
  DAV_NS,
  childrenNamed,
  onlyChildNamed,
  parseDavMultistatus,
  parseDavResponse,
  successfulProperties,
  textOfNode,
  xmlEscape,
} from './carddavXml.js';

function normalizePercentEscapes(value) {
  return value.replace(/%([0-9a-f]{2})/gi, (match, hex) => {
    const byte = Number.parseInt(hex, 16);
    const character = String.fromCharCode(byte);
    return /[A-Za-z0-9\-._~]/.test(character)
      ? character
      : `%${hex.toUpperCase()}`;
  });
}

export function canonicalCollectionUrl(rawUrl, baseUrl) {
  let url;
  try {
    url = new URL(rawUrl, baseUrl);
  } catch {
    throw new CardDavError('CardDAV collection URL was invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username || url.password || url.hash) {
    throw new CardDavError('CardDAV collection URL must be HTTP(S) without credentials or a fragment');
  }
  const pathname = normalizePercentEscapes(url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`);
  const search = normalizePercentEscapes(url.search);
  return `${url.origin}${pathname}${search}`;
}

function recordCollectionIdentity(identity, requestUrl) {
  const canonicalUrl = canonicalCollectionUrl(requestUrl);
  if (identity.canonicalUrl && identity.canonicalUrl !== canonicalUrl) {
    throw new CardDavError('CardDAV operation changed collection identity');
  }
  identity.canonicalUrl = canonicalUrl;
}

const DAV_MAX_DISCOVERY_RESPONSES = 1_000;
const DAV_MAX_SYNC_PAGES = 100;
const DAV_MAX_SYNC_MEMBERS = 50_000;

function withDavOperation(url, operation, callback) {
  if (operation) return callback(operation);
  const ownedOperation = createDavOperation(url);
  return ownedOperation.run(() => callback(ownedOperation));
}

async function runCardResourceOperation(operationName, callback) {
  try {
    return await callback();
  } catch (error) {
    if (error instanceof CardDavError) {
      error.operation = operationName;
      throw error;
    }
    throw new CardDavError(error.message, { operation: operationName, cause: error });
  }
}

function hrefScopeError(message) {
  return Object.assign(new CardDavError(message), { code: 'ERR_DAV_HREF_SCOPE' });
}

function validateResourceRedirect(collectionUrl) {
  return redirectUrl => memberHref(redirectUrl, collectionUrl);
}

function resolveSameOriginHref(rawHref, baseUrl) {
  if (typeof rawHref !== 'string' || !rawHref || rawHref !== rawHref.trim()) {
    throw hrefScopeError('CardDAV href must be a non-empty URI reference');
  }
  if (rawHref.includes('\\')) {
    throw hrefScopeError('CardDAV href must not contain backslashes');
  }
  if (rawHref.includes('#') || /^(?:[a-z][a-z\d+.-]*:)?\/\/[^/?#]*@/i.test(rawHref)) {
    throw hrefScopeError('CardDAV href must not contain credentials or a fragment');
  }
  let base;
  let resolved;
  try {
    base = new URL(baseUrl);
    resolved = new URL(rawHref, base);
  } catch {
    throw hrefScopeError('CardDAV href was not a valid URI reference');
  }
  if (resolved.username || resolved.password || resolved.hash) {
    throw hrefScopeError('CardDAV href must not contain credentials or a fragment');
  }
  if (resolved.origin !== base.origin) {
    throw hrefScopeError('CardDAV href must stay on the credential origin');
  }
  return resolved.href;
}

export function memberHref(rawHref, collectionUrl, { allowCollection = false } = {}) {
  const rawPath = typeof rawHref === 'string' ? rawHref.split(/[?#]/, 1)[0] : '';
  if (/(?:^|\/)(?:\.|%2e){2}(?:\/|$)/i.test(rawPath) || rawPath.includes('\\')) {
    throw hrefScopeError('CardDAV member href escaped its collection');
  }

  const href = resolveSameOriginHref(rawHref, collectionUrl);
  const collection = new URL(collectionUrl);
  const member = new URL(href);
  if (href === collection.href) {
    if (allowCollection) return href;
    throw hrefScopeError('CardDAV member href identified the collection itself');
  }
  if (!collection.pathname.endsWith('/') || !member.pathname.startsWith(collection.pathname)) {
    throw hrefScopeError('CardDAV member href was outside its collection');
  }

  const relativePath = member.pathname.slice(collection.pathname.length);
  const childName = relativePath.endsWith('/') ? relativePath.slice(0, -1) : relativePath;
  if (!childName || childName.includes('/') || childName.includes('\\')
    || /%(?:2f|5c)/i.test(childName)) {
    throw hrefScopeError('CardDAV member href was not a direct collection child');
  }
  return href;
}

function nodesNamed(nodes, namespaceURI, localName) {
  return nodes.filter(node => (
    node.namespaceURI === namespaceURI && node.localName === localName
  ));
}

function optionalProperty(properties, namespaceURI, localName, label) {
  const matches = nodesNamed(properties, namespaceURI, localName);
  if (matches.length > 1) {
    throw new Error(`${label} contained duplicate {${namespaceURI}}${localName} properties`);
  }
  return matches[0] ?? null;
}

function optionalAttribute(node, namespaceURI, localName, label) {
  const matches = (node.attributes || []).filter(attribute => (
    attribute.namespaceURI === namespaceURI && attribute.localName === localName
  ));
  if (matches.length > 1) {
    throw new Error(`${label} contained duplicate {${namespaceURI ?? ''}}${localName} attributes`);
  }
  return matches[0]?.value ?? null;
}

function discoveryProperties(response, label, requiredProperty) {
  if (response.status != null) {
    throw new CardDavError(`${label} failed (${response.status})`, { status: response.status });
  }
  for (const propstat of response.propstats) {
    if (propstat.status >= 200 && propstat.status < 300) continue;
    const failedRequired = propstat.properties.some(node => (
      node.namespaceURI === requiredProperty.namespaceURI
      && node.localName === requiredProperty.localName
    ));
    if (propstat.status !== 404 || failedRequired) {
      throw new CardDavError(`${label} failed (${propstat.status})`, { status: propstat.status });
    }
  }
  const properties = successfulProperties(response);
  if (!optionalProperty(
    properties,
    requiredProperty.namespaceURI,
    requiredProperty.localName,
    label,
  )) {
    throw new Error(
      `${label} did not include a successful {${requiredProperty.namespaceURI}}${requiredProperty.localName}`,
    );
  }
  return properties;
}

// Pure: pull one exact href-valued property out of a PROPFIND multistatus.
// `key` is mapped to its required DAV/CardDAV namespace. Exported for testing.
export function extractHref(xmlText, key, baseUrl) {
  const expectedNamespace = key === 'current-user-principal' ? DAV_NS
    : key === 'addressbook-home-set' ? CARDDAV_NS : null;
  if (!expectedNamespace) throw new TypeError(`Unsupported CardDAV discovery property: ${key}`);

  const multistatus = parseDavMultistatus(xmlText, 'discovery response');
  const responseNodes = childrenNamed(multistatus, DAV_NS, 'response');
  if (responseNodes.length !== 1) {
    throw new Error(`CardDAV discovery response must contain exactly one DAV response; found ${responseNodes.length}`);
  }
  const response = parseDavResponse(responseNodes[0], 'CardDAV discovery response');
  resolveSameOriginHref(response.href, baseUrl);
  if (response.status != null) {
    if (response.status === 404) return null;
    throw new CardDavError(`CardDAV discovery response failed (${response.status})`, {
      status: response.status,
    });
  }
  for (const propstat of response.propstats) {
    if ((propstat.status < 200 || propstat.status >= 300) && propstat.status !== 404) {
      throw new CardDavError(`CardDAV discovery response failed (${propstat.status})`, {
        status: propstat.status,
      });
    }
  }
  const property = optionalProperty(
    successfulProperties(response),
    expectedNamespace,
    key,
    'CardDAV discovery response',
  );
  if (!property) return null;
  const href = textOfNode(onlyChildNamed(
    property,
    DAV_NS,
    'href',
    `{${expectedNamespace}}${key}`,
  ));
  return resolveSameOriginHref(href, baseUrl);
}

// PROPFIND for a single href-valued property. `key` is the expected local name in
// the response (passed explicitly rather than derived from the request markup).
async function propfindHref(url, propXml, key, creds) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><prop>${propXml}</prop></propfind>`;
  const { bodyText, requestUrl } = await davRequest(creds.operation, 'PROPFIND', url, {
    ...creds,
    depth: 0,
    body,
  });
  return extractHref(bodyText, key, requestUrl);
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
      if (err instanceof CardDavError && (err.status === 401 || err.code === 'ERR_DAV_HREF_SCOPE')) {
        throw err;
      }
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return serverUrl; // some servers expose the home set directly at the given URL
}

// Discover every address book on the server for these credentials.
// Returns [{ url, displayName, supportsSyncCollection }].
export async function discoverAddressBooks({ serverUrl, username, password, allowPrivate = false }) {
  const operation = createDavOperation(new URL(serverUrl).origin);
  return operation.run(async () => {
    const creds = { username, password, allowPrivate, operation };

    const principal = await resolvePrincipal(serverUrl, creds);
    const homeSet = await propfindHref(principal, '<C:addressbook-home-set/>', 'addressbook-home-set', creds)
      || principal;

    // Enumerate collections under the home set (Depth: 1).
    const body = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"
  xmlns:cs="http://calendarserver.org/ns/"><prop>
  <resourcetype/><displayname/><cs:getctag/><supported-report-set/>
  <current-user-privilege-set/><C:supported-address-data/></prop></propfind>`;
    const result = await davRequest(operation, 'PROPFIND', homeSet, { ...creds, depth: 1, body });
    const books = parseAddressBooks(result.bodyText, result.requestUrl);
    return books;
  });
}

// Pure: extract address-book collections from a PROPFIND multistatus. Exported
// for testing. Returns [{ url, displayName, supportsSyncCollection,
// capabilities, discoveryIndex, addressData }].
export function parseAddressBooks(xmlText, baseUrl) {
  const multistatus = parseDavMultistatus(xmlText, 'address book discovery response');
  const responseNodes = childrenNamed(multistatus, DAV_NS, 'response');
  if (responseNodes.length > DAV_MAX_DISCOVERY_RESPONSES) {
    throw new Error(
      `CardDAV discovery exceeded the ${DAV_MAX_DISCOVERY_RESPONSES.toLocaleString('en-US')} response limit`,
    );
  }
  const books = [];
  const byUrl = new Map();
  const collectionUrl = new URL(baseUrl).href;
  let foundCollection = false;
  for (const [index, responseNode] of responseNodes.entries()) {
    const label = `CardDAV discovery response ${index + 1}`;
    const response = parseDavResponse(responseNode, label);
    const href = memberHref(response.href, collectionUrl, { allowCollection: true });
    const canonicalUrl = canonicalCollectionUrl(href);
    const properties = discoveryProperties(response, label, {
      namespaceURI: DAV_NS,
      localName: 'resourcetype',
    });
    const resourceType = optionalProperty(properties, DAV_NS, 'resourcetype', label);
    if (resourceType.children.some(node => (
      node.localName === 'addressbook' && node.namespaceURI !== CARDDAV_NS
    ))) {
      throw new Error(`${label} used a foreign addressbook namespace`);
    }
    const isCollection = childrenNamed(resourceType, DAV_NS, 'collection').length > 0;
    const isAddressBook = childrenNamed(resourceType, CARDDAV_NS, 'addressbook').length > 0;

    if (canonicalUrl === canonicalCollectionUrl(collectionUrl)) {
      if (!isCollection) throw new Error(`${label} did not identify the DAV home collection`);
      if (foundCollection) throw new Error('CardDAV discovery returned duplicate home collection self responses');
      foundCollection = true;
      continue;
    }
    if (!isAddressBook) continue;
    if (!isCollection) throw new Error(`${label} did not identify a DAV address book collection`);
    const displayName = optionalProperty(properties, DAV_NS, 'displayname', label);
    const book = {
      url: canonicalUrl,
      displayName: textOfNode(displayName) || 'Contacts',
      supportsSyncCollection: supportedReportsOf(properties, label).syncCollection,
      capabilities: capabilitiesOf(properties, label),
      discoveryIndex: books.length,
      addressData: addressDataOf(properties, label),
    };
    const existing = byUrl.get(canonicalUrl);
    if (existing) {
      if (existing.displayName !== book.displayName
        || existing.supportsSyncCollection !== book.supportsSyncCollection
        || !sameCapabilities(existing.capabilities, book.capabilities)
        || !sameAddressData(existing.addressData, book.addressData)) {
        throw new CardDavError(`CardDAV discovery returned conflicting metadata for ${canonicalUrl}`);
      }
      continue;
    }
    byUrl.set(canonicalUrl, book);
    books.push(book);
  }
  if (!foundCollection) {
    throw new Error('CardDAV discovery did not include the required home collection self response');
  }
  return books;
}

// Pure: detect the incremental REPORT methods advertised by a collection.
export function parseSupportedReports(xmlText) {
  const multistatus = parseDavMultistatus(xmlText, 'supported report discovery response');
  let syncCollection = false;
  let addressbookMultiget = false;
  for (const [index, responseNode] of childrenNamed(multistatus, DAV_NS, 'response').entries()) {
    const label = `CardDAV supported report response ${index + 1}`;
    const response = parseDavResponse(responseNode, label);
    if (response.status != null) {
      throw new CardDavError(`${label} failed (${response.status})`, { status: response.status });
    }
    const reports = supportedReportsOf(successfulProperties(response), label);
    syncCollection ||= reports.syncCollection;
    addressbookMultiget ||= reports.addressbookMultiget;
  }
  return { syncCollection, addressbookMultiget };
}

function supportedReportsOf(properties, label) {
  let syncCollection = false;
  let addressbookMultiget = false;
  const supported = optionalProperty(properties, DAV_NS, 'supported-report-set', label);
  if (!supported) return { syncCollection, addressbookMultiget };
  for (const item of childrenNamed(supported, DAV_NS, 'supported-report')) {
    const report = onlyChildNamed(item, DAV_NS, 'report', `${label} supported-report`);
    syncCollection ||= childrenNamed(report, DAV_NS, 'sync-collection').length > 0;
    addressbookMultiget ||= childrenNamed(report, CARDDAV_NS, 'addressbook-multiget').length > 0;
  }
  return { syncCollection, addressbookMultiget };
}

function capabilitiesOf(properties, label) {
  const current = optionalProperty(properties, DAV_NS, 'current-user-privilege-set', label);
  if (!current) {
    return { create: 'unknown', update: 'unknown', delete: 'unknown' };
  }

  const granted = new Set();
  for (const privilegeNode of childrenNamed(current, DAV_NS, 'privilege')) {
    if (privilegeNode.children.length !== 1) {
      throw new Error(`${label} contained a malformed DAV privilege`);
    }
    const [privilege] = privilegeNode.children;
    if (privilege.namespaceURI !== DAV_NS) continue;
    granted.add(privilege.localName);
    if (privilege.localName === 'write' || privilege.localName === 'all') {
      granted.add('bind');
      granted.add('write-content');
      granted.add('unbind');
    }
  }
  return {
    create: granted.has('bind') ? 'allowed' : 'denied',
    update: granted.has('write-content') ? 'allowed' : 'denied',
    delete: granted.has('unbind') ? 'allowed' : 'denied',
  };
}

function addressDataOf(properties, label) {
  const supported = optionalProperty(properties, CARDDAV_NS, 'supported-address-data', label);
  if (!supported) return [];
  return childrenNamed(supported, CARDDAV_NS, 'address-data-type').map((node, index) => {
    const entryLabel = `${label} supported address data ${index + 1}`;
    return {
      contentType: optionalAttribute(node, null, 'content-type', entryLabel) ?? 'text/vcard',
      version: optionalAttribute(node, null, 'version', entryLabel) ?? '3.0',
    };
  });
}

function sameCapabilities(left, right) {
  return left.create === right.create
    && left.update === right.update
    && left.delete === right.delete;
}

function sameAddressData(left, right) {
  return left.length === right.length && left.every((entry, index) => (
    entry.contentType === right[index].contentType && entry.version === right[index].version
  ));
}

// Pure: build an RFC 6578 sync-collection REPORT body.
export function buildSyncCollectionBody(syncToken) {
  return `<?xml version="1.0" encoding="utf-8"?>
<sync-collection xmlns="DAV:"><sync-token>${xmlEscape(syncToken)}</sync-token>
  <sync-level>1</sync-level><prop><getetag/></prop></sync-collection>`;
}

// Pure: parse one RFC 6578 sync-collection response page.
export function parseSyncPage(xmlText, baseUrl) {
  const multistatus = parseDavMultistatus(xmlText, 'sync response');
  const collectionUrl = new URL(baseUrl).href;
  const events = new Map();
  let truncated = false;

  for (const [index, responseNode] of childrenNamed(multistatus, DAV_NS, 'response').entries()) {
    const label = `CardDAV sync response ${index + 1}`;
    const response = parseDavResponse(responseNode, label);

    if (response.status != null) {
      const href = memberHref(response.href, collectionUrl, {
        allowCollection: response.status === 507,
      });
      if (response.status === 507 && href === collectionUrl) {
        truncated = true;
        continue;
      }
      if (response.status === 404) {
        if (events.has(href)) {
          throw new Error(`CardDAV sync response contained duplicate member href ${href}`);
        }
        events.set(href, { type: 'removed', href });
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        throw new CardDavError(`CardDAV sync failed for ${href} (${response.status})`, {
          status: response.status,
        });
      }
      throw new Error(`${label} did not include requested sync properties`);
    }

    const failedPropstat = response.propstats.find(({ status }) => status < 200 || status >= 300);
    const href = memberHref(response.href, collectionUrl, { allowCollection: Boolean(failedPropstat) });
    if (failedPropstat) {
      throw new CardDavError(`CardDAV sync failed for ${href} (${failedPropstat.status})`, {
        status: failedPropstat.status,
      });
    }
    if (events.has(href)) {
      throw new Error(`CardDAV sync response contained duplicate member href ${href}`);
    }
    const etag = optionalProperty(successfulProperties(response), DAV_NS, 'getetag', label);
    if (!etag) {
      throw new Error(`${label} did not include a successful DAV getetag`);
    }
    events.set(href, {
      type: 'changed',
      href,
      etag: textOfNode(etag),
    });
  }

  const tokenNodes = childrenNamed(multistatus, DAV_NS, 'sync-token');
  const nextToken = tokenNodes.length === 1 ? textOfNode(tokenNodes[0]) : '';
  if (tokenNodes.length !== 1 || !nextToken.trim()) {
    if (truncated) {
      throw new Error('CardDAV sync response was truncated without a continuation token');
    }
    throw new Error('CardDAV sync response did not include a usable sync token');
  }
  return {
    changed: [...events.values()]
      .filter(event => event.type === 'changed')
      .map(({ href, etag: eventEtag }) => ({ href, etag: eventEtag })),
    removed: [...events.values()]
      .filter(event => event.type === 'removed')
      .map(({ href }) => ({ href })),
    nextToken,
    truncated,
  };
}

// Pure: build an RFC 6352 addressbook-multiget REPORT body.
export function buildMultigetBody(hrefs) {
  const requested = hrefs.map(href => `<D:href>${xmlEscape(href)}</D:href>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<C:addressbook-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:prop><D:getetag/><C:address-data/></D:prop>${requested}</C:addressbook-multiget>`;
}

// Fetch one RFC 6578 page without opening any database transaction.
export async function fetchSyncPage({
  url,
  syncToken,
  username,
  password,
  allowPrivate = false,
  operation,
  identity,
}) {
  return withDavOperation(url, operation, async activeOperation => {
    const body = buildSyncCollectionBody(syncToken);
    const { bodyText, requestUrl } = await davRequest(activeOperation, 'REPORT', url, {
      username,
      password,
      depth: 0,
      body,
      allowPrivate,
    });
    if (identity) recordCollectionIdentity(identity, requestUrl);
    return parseSyncPage(bodyText, requestUrl);
  });
}

// Fetch one RFC 6352 multiget batch without opening any database transaction.
export async function fetchCardsByHref({
  url,
  hrefs,
  username,
  password,
  allowPrivate = false,
  operation,
  identity,
}) {
  if (!Array.isArray(hrefs) || hrefs.length === 0) {
    throw new CardDavError('CardDAV multiget requires a non-empty href list');
  }
  const collectionUrl = identity?.canonicalUrl || url;
  const normalizedHrefs = hrefs.map(href => memberHref(href, collectionUrl));
  const requestedHrefs = new Set(normalizedHrefs);
  if (requestedHrefs.size !== normalizedHrefs.length) {
    throw new CardDavError('CardDAV multiget hrefs must be unique after normalization');
  }

  return withDavOperation(url, operation, async activeOperation => {
    const body = buildMultigetBody(normalizedHrefs);
    const { bodyText, requestUrl } = await davRequest(activeOperation, 'REPORT', url, {
      username,
      password,
      depth: 0,
      body,
      allowPrivate,
    });
    if (identity) recordCollectionIdentity(identity, requestUrl);
    const results = parseMultigetCards(bodyText, requestUrl);
    const resultCounts = new Map();
    for (const result of results) {
      resultCounts.set(result.href, (resultCounts.get(result.href) || 0) + 1);
    }
    for (const returnedHref of resultCounts.keys()) {
      if (!requestedHrefs.has(returnedHref)) {
        throw new CardDavError(`CardDAV multiget returned an unrequested response for ${returnedHref}`);
      }
    }
    for (const requestedHref of requestedHrefs) {
      const count = resultCounts.get(requestedHref) || 0;
      if (count !== 1) {
        throw new CardDavError(
          `CardDAV multiget returned ${count} terminal responses for ${requestedHref}`,
        );
      }
    }
    return results;
  });
}

async function fetchSnapshotPlan({ url, syncToken, identity, ...creds }) {
  return {
    expectedRemoteToken: syncToken ?? null,
    nextRemoteToken: null,
    capability: 'snapshot',
    replaceAll: true,
    upserts: await fetchAddressBookCards({ url, identity, ...creds }),
    removedHrefs: [],
  };
}

async function fetchSyncPlan({ url, syncToken, identity, ...creds }) {
  const events = new Map();
  const seenContinuationTokens = new Set();
  let pageToken = syncToken ?? '';
  let page;
  let pageCount = 0;

  while (true) {
    if (pageCount === DAV_MAX_SYNC_PAGES) {
      throw new CardDavError(`CardDAV sync exceeded the ${DAV_MAX_SYNC_PAGES} page limit`);
    }
    seenContinuationTokens.add(pageToken);
    page = await fetchSyncPage({ url, syncToken: pageToken, identity, ...creds });
    pageCount++;
    for (const [eventList, disposition] of [
      [page.changed, 'changed'],
      [page.removed, 'removed'],
    ]) {
      for (const event of eventList) {
        if (!events.has(event.href)) {
          if (events.size === DAV_MAX_SYNC_MEMBERS) {
            throw new CardDavError(
              `CardDAV sync exceeded the ${DAV_MAX_SYNC_MEMBERS.toLocaleString('en-US')} member limit`,
            );
          }
        }
        events.set(event.href, disposition);
      }
    }
    if (!page.truncated) break;
    if (seenContinuationTokens.has(page.nextToken)) {
      throw new CardDavError('CardDAV sync continuation token cycle detected');
    }
    pageToken = page.nextToken;
  }

  const changedHrefs = [...events]
    .filter(([, disposition]) => disposition === 'changed')
    .map(([href]) => href);
  const upserts = [];
  for (let offset = 0; offset < changedHrefs.length; offset += 100) {
    const cards = await fetchCardsByHref({
      url,
      hrefs: changedHrefs.slice(offset, offset + 100),
      identity,
      ...creds,
    });
    for (const card of cards) {
      if (card.status === 404) events.set(card.href, 'removed');
      else upserts.push(card);
    }
  }

  return {
    expectedRemoteToken: syncToken ?? null,
    nextRemoteToken: page.nextToken,
    capability: 'sync-collection',
    replaceAll: syncToken == null || syncToken === '',
    upserts,
    removedHrefs: [...events]
      .filter(([, disposition]) => disposition === 'removed')
      .map(([href]) => href),
  };
}

// Build one complete network plan before callers perform any database write.
export async function fetchAddressBookDelta({
  url,
  syncToken,
  supportsSyncCollection,
  ...creds
}) {
  const observedUrl = canonicalCollectionUrl(url);
  const identity = { canonicalUrl: null };
  const operation = createDavOperation(url);
  return operation.run(async () => {
    const operationCreds = { ...creds, operation };
    let plan;
    if (!supportsSyncCollection) {
      plan = await fetchSnapshotPlan({ url, syncToken, identity, ...operationCreds });
    } else {
      try {
        plan = await fetchSyncPlan({ url, syncToken, identity, ...operationCreds });
      } catch (error) {
        if (!(error instanceof CardDavError)
          || (error.requestStatus !== 405 && error.requestStatus !== 501)) {
          throw error;
        }
        plan = await fetchSnapshotPlan({ url, syncToken, identity, ...operationCreds });
      }
    }
    return { ...plan, collectionIdentity: { observedUrl, canonicalUrl: identity.canonicalUrl } };
  });
}

// Fetch every vCard in an address book via an addressbook-query REPORT.
// Returns [{ href, etag, vcard }].
export async function fetchAddressBookCards({
  url,
  username,
  password,
  allowPrivate = false,
  operation,
  identity,
}) {
  return withDavOperation(url, operation, async activeOperation => {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:prop><D:getetag/><C:address-data/></D:prop>
  <C:filter/>
</C:addressbook-query>`;
    const { bodyText, requestUrl } = await davRequest(activeOperation, 'REPORT', url, {
      username,
      password,
      depth: 1,
      body,
      allowPrivate,
    });
    if (identity) recordCollectionIdentity(identity, requestUrl);
    return parseCards(bodyText, requestUrl);
  });
}

export async function fetchCardResource({
  url,
  href,
  username,
  password,
  allowPrivate = false,
  operation,
}) {
  return runCardResourceOperation('fetch', () => {
    const resourceUrl = memberHref(href, url);
    return withDavOperation(url, operation, async activeOperation => {
      const result = await davRequest(activeOperation, 'GET', resourceUrl, {
        username,
        password,
        headers: { Accept: 'text/vcard' },
        errorOperation: 'fetch',
        validateRedirect: validateResourceRedirect(url),
        allowPrivate,
      });
      const finalHref = memberHref(result.requestUrl, url);
      const etag = result.headers.get('etag');
      if (!etag || !result.bodyText.trim()) {
        throw new CardDavError('CardDAV resource did not include a vCard and ETag', {
          operation: 'fetch',
        });
      }
      return { href: finalHref, etag, vcard: result.bodyText };
    });
  });
}

export async function putCardResource({
  url,
  href,
  etag,
  vcard,
  username,
  password,
  allowPrivate = false,
  operation,
}) {
  const operationName = etag == null ? 'create' : 'update';
  return runCardResourceOperation(operationName, () => {
    if (typeof etag === 'string' && etag.trim() === '*') {
      throw new CardDavError('CardDAV resource update requires a stored ETag', {
        operation: operationName,
      });
    }
    const resourceUrl = memberHref(href, url);
    if (typeof vcard !== 'string') {
      throw new CardDavError('CardDAV resource write requires a vCard', {
        operation: operationName,
      });
    }
    return withDavOperation(url, operation, async activeOperation => {
      const conditionalHeader = operationName === 'create'
        ? { 'If-None-Match': '*' }
        : { 'If-Match': etag };
      const result = await davRequest(activeOperation, 'PUT', resourceUrl, {
        username,
        password,
        body: vcard,
        headers: {
          'Content-Type': 'text/vcard; charset=utf-8',
          ...conditionalHeader,
        },
        errorOperation: operationName,
        validateRedirect: validateResourceRedirect(url),
        allowPrivate,
      });
      const finalHref = memberHref(result.requestUrl, url);
      return { href: finalHref, etag: result.headers.get('etag') };
    });
  });
}

export async function deleteCardResource({
  url,
  href,
  etag,
  username,
  password,
  allowPrivate = false,
  operation,
}) {
  return runCardResourceOperation('delete', () => {
    if (typeof etag === 'string' && etag.trim() === '*') {
      throw new CardDavError('CardDAV resource delete requires a stored ETag', {
        operation: 'delete',
      });
    }
    const resourceUrl = memberHref(href, url);
    if (typeof etag !== 'string') {
      throw new CardDavError('CardDAV resource delete requires an ETag', {
        operation: 'delete',
      });
    }
    return withDavOperation(url, operation, async activeOperation => {
      const result = await davRequest(activeOperation, 'DELETE', resourceUrl, {
        username,
        password,
        headers: { 'If-Match': etag },
        acceptedStatuses: [404],
        errorOperation: 'delete',
        validateRedirect: validateResourceRedirect(url),
        allowPrivate,
      });
      return { href: memberHref(result.requestUrl, url) };
    });
  });
}

function extractCard(response, href, label, errorContext) {
  const failedPropstat = response.propstats.find(({ status }) => status < 200 || status >= 300);
  if (failedPropstat) {
    throw new CardDavError(
      `CardDAV ${errorContext} failed for ${href} (${failedPropstat.status})`,
      { status: failedPropstat.status },
    );
  }
  const properties = successfulProperties(response);
  const etag = optionalProperty(properties, DAV_NS, 'getetag', label);
  const addressData = optionalProperty(properties, CARDDAV_NS, 'address-data', label);
  if (errorContext === 'snapshot' && (!etag || !addressData)) {
    throw new Error(`${label} did not include successful DAV getetag and CardDAV address-data`);
  }
  const vcard = textOfNode(addressData);
  if (errorContext === 'snapshot' && !vcard.trim()) {
    throw new Error(`${label} did not include non-empty CardDAV address-data`);
  }
  if (errorContext === 'multiget' && (!etag || !addressData || !vcard.trim())) {
    throw new CardDavError(
      `CardDAV multiget response for ${href} did not include non-empty address-data`,
    );
  }
  return { href, etag: textOfNode(etag), vcard };
}

// Pure: extract vCards from an addressbook-query/REPORT multistatus. Exported for
// testing. Returns [{ href, etag, vcard }].
export function parseCards(xmlText, baseUrl) {
  const multistatus = parseDavMultistatus(xmlText, 'address book snapshot response');
  const cards = [];
  const collectionUrl = new URL(baseUrl).href;

  for (const [index, responseNode] of childrenNamed(multistatus, DAV_NS, 'response').entries()) {
    const label = `CardDAV snapshot response ${index + 1}`;
    const response = parseDavResponse(responseNode, label);
    const href = memberHref(response.href, collectionUrl, { allowCollection: true });
    const isCollection = href === collectionUrl;

    if (response.status != null) {
      if (response.status === 507) {
        throw new Error('CardDAV server returned a truncated address book response');
      }
      if (response.status < 200 || response.status >= 300) {
        throw new CardDavError(`CardDAV snapshot failed for ${href} (${response.status})`, {
          status: response.status,
        });
      }
      if (isCollection) continue;
      throw new Error(`${label} did not include requested card properties`);
    }

    if (isCollection) {
      const failedSelfPropstat = response.propstats.find(({ status }) => (
        status !== 404 && (status < 200 || status >= 300)
      ));
      if (failedSelfPropstat) {
        throw new CardDavError(`CardDAV snapshot failed for ${href} (${failedSelfPropstat.status})`, {
          status: failedSelfPropstat.status,
        });
      }
      continue;
    }

    cards.push(extractCard(response, href, label, 'snapshot'));
  }
  return cards;
}

// Pure: parse cards and missing resources from an RFC 6352 multiget response.
export function parseMultigetCards(xmlText, baseUrl) {
  const multistatus = parseDavMultistatus(xmlText, 'multiget response');
  const collectionUrl = new URL(baseUrl).href;
  const results = [];
  for (const [index, responseNode] of childrenNamed(multistatus, DAV_NS, 'response').entries()) {
    const label = `CardDAV multiget response ${index + 1}`;
    const response = parseDavResponse(responseNode, label);
    const href = memberHref(response.href, collectionUrl);
    if (response.status != null) {
      if (response.status === 404) {
        results.push({ href, status: response.status });
        continue;
      }
      throw new CardDavError(`CardDAV multiget failed for ${href} (${response.status})`, {
        status: response.status,
      });
    }

    results.push(extractCard(response, href, label, 'multiget'));
  }
  return results;
}

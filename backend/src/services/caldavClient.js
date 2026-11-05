// CalDAV client. Discovers calendars and reads and writes events over WebDAV with HTTP Basic auth.
// Every request goes through safeFetch and the host policy, as server-provided hrefs are attacker-influenced.

import { XMLParser } from 'fast-xml-parser';
import { validateHost } from './hostValidation.js';
import { safeFetch } from './safeFetch.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  trimValues: false,
  processEntities: { maxTotalExpansions: 10_000_000, maxExpansionDepth: 10 },
});

const toArray = x => (Array.isArray(x) ? x : x == null ? [] : [x]);
const textOf = (node) => {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node === 'object' && '#text' in node) return String(node['#text']);
  return '';
};
const absolute = (href, base) => { try { return new URL(href, base).href; } catch { return href; } };
const escapeXml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Same reason as CardDAV: SabreDAV writes each trailing CR as &#13; and the parser leaves numeric references.
function decodeCharRefs(str) {
  return str.replace(/&#([xX][0-9a-fA-F]+|\d+);/g, (match, code) => {
    const cp = /^[xX]/.test(code) ? parseInt(code.slice(1), 16) : parseInt(code, 10);
    if (!Number.isFinite(cp) || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return match;
    return String.fromCodePoint(cp);
  });
}

function propsOf(response) {
  const merged = {};
  for (const ps of toArray(response.propstat)) {
    const status = textOf(ps.status);
    if (status && !/\b2\d\d\b/.test(status)) continue;
    Object.assign(merged, ps.prop || {});
  }
  return merged;
}

async function request(method, url, creds, { depth, body, headers = {}, contentType = 'application/xml; charset=utf-8' } = {}) {
  const { username, password, allowPrivate = false } = creds;
  let hostname;
  try { hostname = new URL(url).hostname; } catch { throw new Error('Invalid server URL'); }
  const hostErr = await validateHost(hostname, { allowPrivate });
  if (hostErr) throw new Error(hostErr);
  const all = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`, ...headers };
  if (body != null) all['Content-Type'] = contentType;
  if (depth != null) all.Depth = String(depth);
  let res;
  try {
    res = await safeFetch(url, { method, headers: all, body, redirect: 'follow', signal: AbortSignal.timeout(30000) }, { allowPrivate });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error('CalDAV server did not respond (timed out)', { cause: err });
    throw new Error(`Could not reach the CalDAV server: ${err.message}`, { cause: err });
  }
  if (res.status === 401) throw Object.assign(new Error('Authentication failed — check the username and app password'), { status: 401 });
  return res;
}

async function dav(method, url, creds, opts) {
  const res = await request(method, url, creds, opts);
  if (!res.ok) {
    throw Object.assign(new Error(`CalDAV request failed (${res.status} ${res.statusText})`), { status: res.status });
  }
  return res.text();
}

export function parseHref(xmlText, key, baseUrl) {
  const response = toArray(parser.parse(xmlText)?.multistatus?.response)[0];
  if (!response) return null;
  const val = propsOf(response)[key];
  const href = toArray(val?.href ?? val)[0];
  const text = textOf(href).trim();
  return text ? absolute(text, baseUrl) : null;
}

async function propfindHref(url, prop, key, creds) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><prop>${prop}</prop></propfind>`;
  return parseHref(await dav('PROPFIND', url, creds, { depth: 0, body }), key, url);
}

async function resolvePrincipal(serverUrl, creds) {
  const origin = new URL(serverUrl).origin;
  let lastErr;
  for (const base of [serverUrl, `${origin}/.well-known/caldav`]) {
    try {
      const principal = await propfindHref(base, '<current-user-principal/>', 'current-user-principal', creds);
      if (principal) return principal;
    } catch (err) {
      if (err.status === 401) throw err;
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return serverUrl;
}

// Writable unless the server lists privileges and write is not among them. No list says nothing.
function readOnlyFrom(privilegeSet) {
  if (!privilegeSet || typeof privilegeSet !== 'object') return false;
  const privileges = toArray(privilegeSet.privilege);
  if (!privileges.length) return false;
  return !privileges.some(p => p && typeof p === 'object' && ('write' in p || 'write-content' in p || 'all' in p));
}

function colorFrom(raw) {
  const m = /^#?([0-9a-fA-F]{6})/.exec(textOf(raw).trim());
  return m ? `#${m[1].toLowerCase()}` : null;
}

// Pure. Calendars able to hold events, out of a Depth 1 PROPFIND of the calendar home.
export function parseCalendars(xmlText, baseUrl) {
  const calendars = [];
  for (const response of toArray(parser.parse(xmlText)?.multistatus?.response)) {
    const props = propsOf(response);
    if (!props.resourcetype || typeof props.resourcetype !== 'object' || !('calendar' in props.resourcetype)) continue;
    const comps = toArray(props['supported-calendar-component-set']?.comp).map(c => c?.['@_name']);
    if (comps.length && !comps.includes('VEVENT')) continue;
    const href = textOf(response.href).trim();
    if (!href) continue;
    const url = absolute(href, baseUrl);
    calendars.push({
      url,
      name: textOf(props.displayname).trim() || decodeURIComponent(url.replace(/\/$/, '').split('/').pop()) || 'Calendar',
      color: colorFrom(props['calendar-color']),
      ctag: textOf(props.getctag).trim() || null,
      readOnly: readOnlyFrom(props['current-user-privilege-set']),
    });
  }
  return calendars;
}

export async function discoverCalendars({ serverUrl, username, password, allowPrivate = false }) {
  const creds = { username, password, allowPrivate };
  const principal = await resolvePrincipal(serverUrl, creds);
  const home = await propfindHref(principal, '<C:calendar-home-set/>', 'calendar-home-set', creds) || principal;
  const body = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/"><prop>
  <resourcetype/><displayname/><current-user-privilege-set/><CS:getctag/><A:calendar-color/><C:supported-calendar-component-set/>
</prop></propfind>`;
  const calendars = parseCalendars(await dav('PROPFIND', home, creds, { depth: 1, body }), home);
  if (!calendars.length) throw new Error('No calendars found for this account');
  return calendars;
}

// Pure. A listing or multiget. A 507 anywhere means the server cut the answer short, which must not
// read as "the other events are gone".
export function parseResources(xmlText, calendarUrl) {
  const responses = toArray(parser.parse(xmlText)?.multistatus?.response);
  if (responses.some(r => /\b507\b/.test(textOf(r.status)))) {
    throw new Error('CalDAV server returned a truncated response');
  }
  const self = absolute(calendarUrl, calendarUrl).replace(/\/$/, '');
  const out = [];
  for (const response of responses) {
    const rawHref = textOf(response.href).trim();
    if (!rawHref) continue;
    const url = absolute(rawHref, calendarUrl);
    if (url.replace(/\/$/, '') === self) continue;
    const props = propsOf(response);
    if (props.resourcetype && typeof props.resourcetype === 'object' && 'collection' in props.resourcetype) continue;
    const contentType = textOf(props.getcontenttype);
    if (contentType && !/calendar/i.test(contentType)) continue;
    const data = decodeCharRefs(textOf(props['calendar-data'])).trim();
    out.push({ rawHref, url, etag: textOf(props.getetag).trim() || null, ical: data || null });
  }
  return out;
}

const QUERY_UNSUPPORTED = new Set([400, 403, 405, 415, 422, 501]);
export const MULTIGET_BATCH = 100;

// Hrefs and etags of every event in a calendar. Complete or throwing, never partial.
export async function listEvents(calendarUrl, creds) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><prop><getetag/></prop>
<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter></C:filter></C:calendar-query>`;
  try {
    return parseResources(await dav('REPORT', calendarUrl, creds, { depth: 1, body }), calendarUrl);
  } catch (err) {
    if (!QUERY_UNSUPPORTED.has(err.status)) throw err;
  }
  const listing = await dav('PROPFIND', calendarUrl, creds, { depth: 1, body: `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:"><prop><getetag/><getcontenttype/><resourcetype/></prop></propfind>` });
  return parseResources(listing, calendarUrl);
}

export async function fetchEvents(calendarUrl, hrefs, creds) {
  const events = [];
  for (let i = 0; i < hrefs.length; i += MULTIGET_BATCH) {
    const batch = hrefs.slice(i, i + MULTIGET_BATCH);
    const body = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-multiget xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><prop><getetag/><C:calendar-data/></prop>${batch.map(h => `<href>${escapeXml(h)}</href>`).join('')}</C:calendar-multiget>`;
    try {
      events.push(...parseResources(await dav('REPORT', calendarUrl, creds, { depth: 1, body }), calendarUrl));
    } catch (err) {
      if (!QUERY_UNSUPPORTED.has(err.status)) throw err;
      for (const href of batch) {
        const one = await getEvent(absolute(href, calendarUrl), creds);
        if (one) events.push({ rawHref: href, url: absolute(href, calendarUrl), ...one });
      }
    }
  }
  return events;
}

export async function getEvent(url, creds) {
  const res = await request('GET', url, creds);
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw Object.assign(new Error(`CalDAV request failed (${res.status} ${res.statusText})`), { status: res.status });
  return { etag: res.headers.get('etag'), ical: await res.text() };
}

// 412 is the server saying the event is not the version this edit was made from.
export async function putEvent(url, ical, creds, { etag, create = false } = {}) {
  const headers = create ? { 'If-None-Match': '*' } : (etag ? { 'If-Match': etag } : {});
  const res = await request('PUT', url, creds, { body: ical, headers, contentType: 'text/calendar; charset=utf-8' });
  if (res.status === 412) throw Object.assign(new Error('Event changed on the server'), { conflict: true });
  if (!res.ok) {
    throw Object.assign(new Error(`The CalDAV server refused the event (${res.status} ${res.statusText})`), { status: res.status });
  }
}

export async function deleteEvent(url, creds, { etag } = {}) {
  const res = await request('DELETE', url, creds, { headers: etag ? { 'If-Match': etag } : {} });
  if (res.status === 412) throw Object.assign(new Error('Event changed on the server'), { conflict: true });
  if (res.status === 404 || res.status === 410) return;
  if (!res.ok) {
    throw Object.assign(new Error(`The CalDAV server refused the deletion (${res.status} ${res.statusText})`), { status: res.status });
  }
}

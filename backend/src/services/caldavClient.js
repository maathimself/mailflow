// CalDAV client. Discovers calendars and reads and writes events over WebDAV with HTTP Basic auth.
// Every request goes through safeFetch and the host policy, as server-provided hrefs are attacker-influenced.

import crypto from 'node:crypto';
import dns from 'node:dns/promises';
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

const MAX_REDIRECTS = 5;
const WELL_KNOWN_PATHS = ['/.well-known/caldav', '/dav/', '/caldav/', '/remote.php/dav/', '/dav.php/', '/cal.php/', '/SOGo/dav/', '/webdav/caldav/'];

// Pure. The Authorization header answering an RFC 7616 Digest challenge, or null for a challenge
// that is not Digest or uses an algorithm unknown here.
export function digestHeader(challenge, { username, password, method, url, cnonce = crypto.randomBytes(8).toString('hex') }) {
  const at = challenge.search(/digest\s/i);
  if (at < 0) return null;
  const params = {};
  for (const m of challenge.slice(at + 7).matchAll(/([a-zA-Z-]+)=(?:"([^"]*)"|([^\s,]+))/g)) {
    const key = m[1].toLowerCase();
    if (!(key in params)) params[key] = m[2] ?? m[3];
  }
  const algorithm = (params.algorithm || 'MD5').toUpperCase();
  const hashName = { MD5: 'md5', 'SHA-256': 'sha256' }[algorithm];
  if (!hashName || !params.nonce) return null;
  const hash = str => crypto.createHash(hashName).update(str).digest('hex');
  const uri = new URL(url).pathname + new URL(url).search;
  const ha1 = hash(`${username}:${params.realm ?? ''}:${password}`);
  const ha2 = hash(`${method}:${uri}`);
  const qop = (params.qop || '').split(',').map(q => q.trim()).includes('auth') ? 'auth' : null;
  const nc = '00000001';
  const response = qop ? hash(`${ha1}:${params.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : hash(`${ha1}:${params.nonce}:${ha2}`);
  const quote = str => String(str).replace(/["\\]/g, '\\$&');
  return [
    `Digest username="${quote(username)}"`, `realm="${quote(params.realm ?? '')}"`, `nonce="${quote(params.nonce)}"`,
    `uri="${quote(uri)}"`, `algorithm=${algorithm}`, `response="${response}"`,
    ...(params.opaque != null ? [`opaque="${quote(params.opaque)}"`] : []),
    ...(qop ? [`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`] : []),
  ].join(', ');
}

// Redirects are followed here rather than by fetch, which would drop Authorization on a move to
// another host and change the verb. Well-known discovery commonly moves hosts (iCloud), and the
// account's server is trusted as far as it is when it names a calendar home on another host.
async function request(method, url, creds, { depth, body, headers = {}, contentType = 'application/xml; charset=utf-8' } = {}, hops = 0) {
  const { username, password, allowPrivate = false } = creds;
  let hostname;
  try { hostname = new URL(url).hostname; } catch { throw new Error('Invalid server URL'); }
  const hostErr = await validateHost(hostname, { allowPrivate });
  if (hostErr) throw new Error(hostErr);
  const all = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`, ...headers };
  if (body) all['Content-Type'] = contentType;
  if (depth != null) all.Depth = String(depth);
  const send = async () => {
    try {
      return await safeFetch(url, { method, headers: all, body, redirect: 'manual', signal: AbortSignal.timeout(30000) }, { allowPrivate });
    } catch (err) {
      if (err.name === 'TimeoutError') throw new Error('CalDAV server did not respond (timed out)', { cause: err });
      throw new Error(`Could not reach the CalDAV server: ${err.message}`, { cause: err });
    }
  };
  let res = await send();
  if (res.status === 401) {
    const digest = digestHeader(res.headers.get('www-authenticate') || '', { username, password, method, url });
    if (digest) {
      await res.body?.cancel();
      all.Authorization = digest;
      res = await send();
    }
  }
  if (res.status === 401) throw Object.assign(new Error('Authentication failed — check the username and app password'), { status: 401 });
  if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
    if (hops >= MAX_REDIRECTS) throw new Error('The CalDAV server redirected too many times');
    await res.body?.cancel();
    return request(method, new URL(res.headers.get('location'), url).href, creds, { depth, body, headers, contentType }, hops + 1);
  }
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

// RFC 6764: a domain can name its CalDAV host and path in DNS.
async function srvCandidate(hostname) {
  try {
    const [srv] = await dns.resolveSrv(`_caldavs._tcp.${hostname}`);
    if (!srv?.name) return null;
    const txt = await dns.resolveTxt(`_caldavs._tcp.${hostname}`).catch(() => []);
    const path = txt.flat().find(t => t.startsWith('path='))?.slice(5) || '/';
    return `https://${srv.name}:${srv.port}${path}`;
  } catch {
    return null;
  }
}

// The URL the user gave, then the standard and the common locations on that server. A server
// that answers but names no principal may still hold the calendars at the URL itself.
async function resolvePrincipal(serverUrl, creds) {
  const { origin, hostname } = new URL(serverUrl);
  const candidates = [serverUrl, ...WELL_KNOWN_PATHS.map(path => `${origin}${path}`)];
  const srv = await srvCandidate(hostname);
  if (srv) candidates.splice(1, 0, srv);
  let answered = false;
  let lastErr;
  for (const base of candidates) {
    try {
      const principal = await propfindHref(base, '<current-user-principal/>', 'current-user-principal', creds);
      if (principal) return principal;
      if (base === serverUrl) answered = true;
    } catch (err) {
      if (err.status === 401) throw err;
      lastErr = err;
    }
  }
  if (answered || !lastErr) return serverUrl;
  throw lastErr;
}

async function calendarHome(principal, creds) {
  try {
    return await propfindHref(principal, '<C:calendar-home-set/>', 'calendar-home-set', creds) || principal;
  } catch (err) {
    if (err.status === 401) throw err;
    return principal;
  }
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
  const home = await calendarHome(principal, creds);
  const body = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/"><prop>
  <resourcetype/><displayname/><current-user-privilege-set/><CS:getctag/><A:calendar-color/><C:supported-calendar-component-set/>
</prop></propfind>`;
  const calendars = parseCalendars(await dav('PROPFIND', home, creds, { depth: 1, body }), home);
  if (!calendars.length) throw new Error('No calendars found for this account');
  return calendars;
}

// The first of these hosts that serves CalDAV with these credentials. Credentials only ever go to
// the hosts given: a mail password is not offered to whatever a domain name happens to point at.
export async function findCalDavServer(hosts, { username, password, allowPrivate = false }) {
  let lastErr;
  for (const host of [...new Set(hosts.filter(Boolean))]) {
    const serverUrl = `https://${host}/`;
    try {
      const calendars = await discoverCalendars({ serverUrl, username, password, allowPrivate });
      return { serverUrl, calendars };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('No CalDAV server found');
}

// Servers spell one href several ways (%40 or @, %7B or {), so hrefs compare through this.
export function hrefKey(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.split('/').map((seg) => {
      try { return decodeURIComponent(seg); } catch { return seg; }
    }).join('/')}`;
  } catch {
    return url;
  }
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
    throw Object.assign(new Error(`The CalDAV server refused the event (${res.status} ${res.statusText})`), { status: res.status, forbidden: res.status === 403 });
  }
  const location = res.headers.get('location');
  return { url: location ? new URL(location, url).href : url };
}

export async function deleteEvent(url, creds, { etag } = {}) {
  // The empty body sends Content-Length: 0, which MDaemon answers 411 without.
  const res = await request('DELETE', url, creds, { body: '', headers: etag ? { 'If-Match': etag } : {} });
  if (res.status === 412) throw Object.assign(new Error('Event changed on the server'), { conflict: true });
  if (res.status === 404 || res.status === 410) return;
  if (!res.ok) {
    throw Object.assign(new Error(`The CalDAV server refused the deletion (${res.status} ${res.statusText})`), { status: res.status, forbidden: res.status === 403 });
  }
}

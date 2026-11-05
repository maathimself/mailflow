import http from 'node:http';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { digestHeader, discoverCalendars, findCalDavServer, hrefKey, parseCalendars, parseHref, parseResources } from './caldavClient.js';

const BASE = 'https://dav.example.com/cal/noe/';

describe('parseCalendars', () => {
  const xml = (props, href = '/cal/noe/perso/') => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/" xmlns:cs="http://calendarserver.org/ns/">
    <d:response><d:href>/cal/noe/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
    <d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
  </d:multistatus>`;
  const CAL = '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>';

  it('reads a calendar and normalizes an 8-digit color', () => {
    const [c] = parseCalendars(xml(`${CAL}<d:displayname>Perso</d:displayname><a:calendar-color>#FF8800FF</a:calendar-color><cs:getctag>abc</cs:getctag>`), BASE);
    expect(c).toEqual({ url: 'https://dav.example.com/cal/noe/perso/', name: 'Perso', color: '#ff8800', ctag: 'abc', readOnly: false });
  });

  it('skips a task-only calendar', () => {
    expect(parseCalendars(xml(`${CAL}<c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>`), BASE)).toEqual([]);
  });

  it('marks a calendar without a write privilege read-only', () => {
    const ro = '<d:current-user-privilege-set><d:privilege><d:read/></d:privilege></d:current-user-privilege-set>';
    expect(parseCalendars(xml(`${CAL}${ro}`), BASE)[0].readOnly).toBe(true);
    const rw = '<d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>';
    expect(parseCalendars(xml(`${CAL}${rw}`), BASE)[0].readOnly).toBe(false);
  });

  it('falls back to the collection name for a calendar with no display name', () => {
    expect(parseCalendars(xml(CAL, '/cal/noe/my%20work/'), BASE)[0].name).toBe('my work');
  });
});

describe('parseResources', () => {
  it('skips the collection itself and decodes numeric references', () => {
    const out = parseResources(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
      <d:response><d:href>/cal/noe/perso/</d:href><d:propstat><d:prop><d:getetag>"c"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
      <d:response><d:href>/cal/noe/perso/a.ics</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag><c:calendar-data>BEGIN:VCALENDAR&#13;
END:VCALENDAR</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
    </d:multistatus>`, `${BASE}perso/`);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ rawHref: '/cal/noe/perso/a.ics', url: 'https://dav.example.com/cal/noe/perso/a.ics', etag: '"1"' });
    expect(out[0].ical).toBe('BEGIN:VCALENDAR\r\nEND:VCALENDAR');
  });

  it('throws on a truncated answer rather than reading it as deletions', () => {
    expect(() => parseResources('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/x</d:href><d:status>HTTP/1.1 507 Insufficient Storage</d:status></d:response></d:multistatus>', BASE))
      .toThrow(/truncated/);
  });
});

describe('parseHref', () => {
  it('takes the first of several hrefs', () => {
    expect(parseHref(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/a/</d:href><d:href>/b/</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`, 'calendar-home-set', BASE))
      .toBe('https://dav.example.com/a/');
  });
});

describe('digestHeader', () => {
  it('matches the worked example of RFC 2617', () => {
    const header = digestHeader('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"', {
      username: 'Mufasa', password: 'Circle Of Life', method: 'GET', url: 'http://www.nowhere.org/dir/index.html', cnonce: '0a4f113b',
    });
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(header).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  });
  it('returns null for a challenge that is not Digest', () => {
    expect(digestHeader('Basic realm="x"', { username: 'a', password: 'b', method: 'GET', url: 'http://x/' })).toBeNull();
  });
});

describe('hrefKey', () => {
  it('treats two spellings of one href as the same', () => {
    expect(hrefKey('https://a.example/c/x%40y.ics')).toBe(hrefKey('https://a.example/c/x@y.ics'));
    expect(hrefKey('https://a.example/c/%7Bid%7D.ics')).toBe(hrefKey('https://a.example/c/{id}.ics'));
  });
});

describe('against a server', () => {
  let server;
  afterEach(() => server?.close());
  const multi = inner => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${inner}</d:multistatus>`;
  const prop = (href, inner) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${inner}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  const start = handler => new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => handler(req, res, body));
    }).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  const calendarAnswer = (res, url, body) => {
    res.writeHead(207, { 'Content-Type': 'application/xml' });
    if (body.includes('current-user-principal')) res.end(multi(prop(url, '<d:current-user-principal><d:href>/p/</d:href></d:current-user-principal>')));
    else if (body.includes('calendar-home-set')) res.end(multi(prop(url, '<c:calendar-home-set><d:href>/h/</d:href></c:calendar-home-set>')));
    else res.end(multi(prop('/h/work/', '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Work</d:displayname>')));
  };

  it('answers a Digest challenge', async () => {
    const base = await start((req, res, body) => {
      if (!/^Digest /.test(req.headers.authorization || '')) {
        res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="r", qop="auth", nonce="n1"' });
        return res.end();
      }
      const a = Object.fromEntries([...req.headers.authorization.matchAll(/(\w+)="?([^",]+)"?/g)].map(m => [m[1], m[2]]));
      const md5 = s => crypto.createHash('md5').update(s).digest('hex');
      const good = md5(`${md5('u:r:p')}:n1:${a.nc}:${a.cnonce}:auth:${md5(`${req.method}:${req.url}`)}`);
      if (a.response !== good) { res.writeHead(401); return res.end(); }
      calendarAnswer(res, req.url, body);
    });
    const cals = await discoverCalendars({ serverUrl: `${base}/`, username: 'u', password: 'p', allowPrivate: true });
    expect(cals.map(c => c.name)).toEqual(['Work']);
  });

  it('keeps the verb and the credentials through a redirect', async () => {
    const seen = [];
    const base = await start((req, res, body) => {
      seen.push([req.method, req.url, req.headers.authorization]);
      if (req.url === '/.well-known/caldav') { res.writeHead(301, { Location: '/dav/' }); return res.end(); }
      if (req.url === '/') { res.writeHead(404); return res.end(); }
      calendarAnswer(res, req.url, body);
    });
    const cals = await discoverCalendars({ serverUrl: `${base}/`, username: 'u', password: 'p', allowPrivate: true });
    expect(cals).toHaveLength(1);
    expect(seen.find(s => s[1] === '/dav/')).toEqual(['PROPFIND', '/dav/', `Basic ${Buffer.from('u:p').toString('base64')}`]);
  });

  it('stops at the first refusal of the credentials', async () => {
    let hits = 0;
    const base = await start((req, res) => { hits++; res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }); res.end(); });
    await expect(discoverCalendars({ serverUrl: `${base}/`, username: 'u', password: 'bad', allowPrivate: true })).rejects.toThrow(/Authentication failed/);
    expect(hits).toBe(1);
  });

  it('finds calendars on a server with no principal support', async () => {
    const base = await start((req, res, body) => {
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      if (body.includes('current-user-principal') || body.includes('calendar-home-set')) return res.end(multi(prop(req.url, '<d:displayname>root</d:displayname>')));
      res.end(multi(prop('/cal/', '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>')));
    });
    expect(await discoverCalendars({ serverUrl: `${base}/`, username: 'u', password: 'p', allowPrivate: true })).toHaveLength(1);
  });

  it('offers credentials only to the hosts it is given', async () => {
    await expect(findCalDavServer([null, undefined], { username: 'u', password: 'p' })).rejects.toThrow(/No CalDAV server/);
  });
});

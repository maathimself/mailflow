import { describe, expect, it } from 'vitest';
import { parseCalendars, parseHref, parseResources } from './caldavClient.js';

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

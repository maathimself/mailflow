// Google's CardDAV server rejects addressbook-query with 400 and implements only a PROPFIND
// listing plus addressbook-multiget (#503). These drive fetchAddressBookCards against a fake
// server to pin both flows and the conditions for falling back.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./hostValidation.js', () => ({ validateHost: vi.fn(async () => null) }));
vi.mock('./safeFetch.js', () => ({ safeFetch: vi.fn() }));

import { fetchAddressBookCards, parseCardHrefs, MULTIGET_BATCH } from './carddavClient.js';
import { safeFetch } from './safeFetch.js';

const BOOK = 'https://www.googleapis.com/carddav/v1/principals/u@example.com/lists/default/';
const reply = (status, text = '') => ({ status, ok: status >= 200 && status < 300, statusText: String(status), text: async () => text });
const vcard = n => `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Person ${n}\r\nEMAIL:p${n}@example.com\r\nEND:VCARD`;
const listing = ids => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
  <d:response><d:href>/carddav/v1/principals/u@example.com/lists/default/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
  ${ids.map(id => `<d:response><d:href>/carddav/v1/principals/u@example.com/lists/default/${id}</d:href>
    <d:propstat><d:prop><d:getetag>"e${id}"</d:getetag><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('')}
</d:multistatus>`;
const cardsFor = ids => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
  ${ids.map(id => `<d:response><d:href>/carddav/v1/principals/u@example.com/lists/default/${id}</d:href>
    <d:propstat><d:prop><d:getetag>"e${id}"</d:getetag><c:address-data>${vcard(id)}</c:address-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('')}
</d:multistatus>`;

// A server that answers like Google: no addressbook-query, PROPFIND and multiget work.
function googleLike(ids) {
  safeFetch.mockImplementation(async (url, opts) => {
    if (opts.method === 'REPORT' && opts.body.includes('addressbook-query')) return reply(400, 'Bad Request');
    if (opts.method === 'PROPFIND') return reply(207, listing(ids));
    if (opts.method === 'REPORT' && opts.body.includes('addressbook-multiget')) {
      const asked = [...opts.body.matchAll(/<href>[^<]*\/([^/<]+)<\/href>/g)].map(m => m[1]);
      return reply(207, cardsFor(asked));
    }
    return reply(500);
  });
}
const creds = { url: BOOK, username: 'u@example.com', password: 'app-password' };

describe('fetchAddressBookCards on a server without addressbook-query (#503)', () => {
  beforeEach(() => { safeFetch.mockReset(); });

  it('falls back to PROPFIND plus addressbook-multiget and returns every card', async () => {
    googleLike(['c1', 'c2', 'c3']);
    const cards = await fetchAddressBookCards(creds);
    expect(cards.map(c => c.href)).toEqual(['c1', 'c2', 'c3'].map(id => new URL(`/carddav/v1/principals/u@example.com/lists/default/${id}`, BOOK).href));
    expect(cards[1].vcard).toContain('FN:Person c2');
    expect(cards[1].etag).toBe('ec2');
    expect(safeFetch.mock.calls.map(([, o]) => o.method)).toEqual(['REPORT', 'PROPFIND', 'REPORT']);
    const multiget = safeFetch.mock.calls[2][1];
    expect(multiget.headers.Depth).toBeUndefined();   // RFC 6352: servers ignore it on multiget
  });

  it('asks for cards in batches, so a large book is never one unbounded response', async () => {
    const ids = Array.from({ length: MULTIGET_BATCH * 2 + 5 }, (_, i) => `c${i}`);
    googleLike(ids);
    const cards = await fetchAddressBookCards(creds);
    expect(cards).toHaveLength(ids.length);
    const multigets = safeFetch.mock.calls.filter(([, o]) => o.body.includes('addressbook-multiget'));
    expect(multigets).toHaveLength(3);
  });

  it('an empty book costs no multiget', async () => {
    googleLike([]);
    expect(await fetchAddressBookCards(creds)).toEqual([]);
    expect(safeFetch.mock.calls.filter(([, o]) => o.body.includes('addressbook-multiget'))).toHaveLength(0);
  });
});

describe('fetchAddressBookCards on servers that answer addressbook-query', () => {
  beforeEach(() => { safeFetch.mockReset(); });

  it('uses the single query and nothing else', async () => {
    safeFetch.mockResolvedValue(reply(207, cardsFor(['n1', 'n2'])));
    const cards = await fetchAddressBookCards(creds);
    expect(cards).toHaveLength(2);
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  it('does not fall back on a failed login', async () => {
    safeFetch.mockResolvedValue(reply(401));
    await expect(fetchAddressBookCards(creds)).rejects.toThrow(/Authentication failed/);
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  it('does not fall back when the book itself is gone', async () => {
    safeFetch.mockResolvedValue(reply(404));
    await expect(fetchAddressBookCards(creds)).rejects.toThrow(/404/);
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });
});

describe('parseCardHrefs', () => {
  it('lists card hrefs as the server wrote them, skipping the book and sub-collections', () => {
    const xml = listing(['a', 'b']).replace('</d:multistatus>', `<d:response><d:href>/carddav/v1/principals/u@example.com/lists/default/sub/</d:href>
      <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);
    expect(parseCardHrefs(xml, BOOK)).toEqual([
      '/carddav/v1/principals/u@example.com/lists/default/a',
      '/carddav/v1/principals/u@example.com/lists/default/b',
    ]);
  });
});

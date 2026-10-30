import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The CardDAV address book routes look the book up through services/ownership.js. A signed-in
// user naming another user's book under their own principal gets a bare 404, with nothing
// written; the owner's book is served and written as before.
vi.mock('../services/redis.js', () => ({
  redisClient: { incr: vi.fn(async () => 1), decr: vi.fn(async () => 0), pExpire: vi.fn(async () => true), pTTL: vi.fn(async () => 60000), del: vi.fn(async () => 1) },
}));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/authLimiter.js', () => ({ authLimiterConfig: { maxRequests: 1000, windowMs: 60000 } }));

import express from 'express';
import bcrypt from 'bcryptjs';
import carddavRouter from './carddav.js';
import { query } from '../services/db.js';

const BOOK_ID = 'e5e5e5e5-5555-4555-8555-e5e5e5e5e5e5';
const HASH = bcrypt.hashSync('pw', 4);
const VCARD = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:c1\r\nFN:Ann\r\nEMAIL:ann@example.com\r\nEND:VCARD\r\n';

const flat = sql => sql.replace(/\s+/g, ' ').trim();
let writes;
function fakeQuery(rawSql, params = []) {
  const sql = flat(rawSql);
  if (/^(UPDATE|DELETE|INSERT)\b/.test(sql)) writes.push(sql);
  if (sql.startsWith('SELECT id, password_hash, totp_enabled FROM users')) {
    return { rows: [{ id: params[0], password_hash: HASH, totp_enabled: false }] };
  }
  if (/^SELECT .+ FROM address_books WHERE id = \$1 AND user_id = \$2$/.test(sql)) {
    return { rows: params[0] === BOOK_ID && params[1] === 'owner' ? [{ id: BOOK_ID, user_id: 'owner', name: 'Contacts', sync_token: 't1' }] : [] };
  }
  return { rows: [] };
}

let server, base;
beforeAll(async () => {
  const app = express();
  app.use('/carddav', carddavRouter);
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/carddav`;
});
afterAll(() => new Promise(r => server.close(r)));
beforeEach(() => {
  writes = [];
  query.mockReset().mockImplementation(async (sql, params) => fakeQuery(sql, params));
});

const dav = (user, method, path, body) => fetch(`${base}/${user}/${BOOK_ID}/${path}`, {
  method,
  headers: { Authorization: `Basic ${Buffer.from(`${user}:pw`).toString('base64')}`, Depth: '1', 'Content-Type': 'text/xml' },
  body,
});

const requests = [
  ['PROPFIND the book', 'PROPFIND', '', undefined, 207],
  ['REPORT on the book', 'REPORT', '', '<C:addressbook-query xmlns:C="urn:ietf:params:xml:ns:carddav"/>', 207],
  ['PUT a contact into the book', 'PUT', 'c1.vcf', VCARD, 201],
];

describe('CardDAV address book ownership', () => {
  it.each(requests)('refuses %s of another user with a bare 404', async (_name, method, path, body) => {
    const res = await dav('stranger', method, path, body);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
    expect(writes).toEqual([]);
  });

  it.each(requests)('serves %s to its owner', async (_name, method, path, body, status) => {
    const res = await dav('owner', method, path, body);
    expect(res.status).toBe(status);
  });
});

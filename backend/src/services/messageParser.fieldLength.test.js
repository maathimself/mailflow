import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { parseMessage, capHeaderField, MAX_HEADER_FIELD } from './messageParser.js';

// #584: messages keeps sender names, addresses and the Message-ID in VARCHAR(500) columns. A sender
// name mis-encoded until it decoded to 546 characters made PostgreSQL reject the row, so the message
// never imported and backfill retried it every pass.
const msg = (envelope) => ({ uid: 1, envelope, flags: [] });
const longName = 'Invitation '.repeat(50);              // 550 characters
const emojiAtEdge = 'a'.repeat(MAX_HEADER_FIELD - 1) + '😀' + 'tail';

describe('capHeaderField', () => {
  it('leaves short values and non-strings alone', () => {
    expect(capHeaderField('Alice')).toBe('Alice');
    expect(capHeaderField(null)).toBeNull();
    expect(capHeaderField(undefined)).toBeUndefined();
    expect(capHeaderField('x'.repeat(MAX_HEADER_FIELD))).toHaveLength(MAX_HEADER_FIELD);
  });

  it('cuts at 500 characters without splitting a surrogate pair', () => {
    expect(capHeaderField(longName)).toBe(longName.slice(0, MAX_HEADER_FIELD));
    const cut = capHeaderField(emojiAtEdge);
    expect(cut).toBe('a'.repeat(MAX_HEADER_FIELD - 1));
    expect(cut.isWellFormed()).toBe(true);
  });
});

describe('parseMessage caps every VARCHAR(500) field', () => {
  it('a 550-character sender name, as in the report', async () => {
    const p = await parseMessage(msg({ from: [{ name: longName, address: 'invites@example.com' }] }));
    expect(p.fromName).toHaveLength(MAX_HEADER_FIELD);
    expect(p.fromEmail).toBe('invites@example.com');
  });

  it('the Message-ID, addresses and the Sender name too', async () => {
    const huge = `<${'m'.repeat(900)}@example.com>`;
    const p = await parseMessage(msg({
      messageId: huge,
      from: [{ name: 'Boss', address: `${'b'.repeat(600)}@corp.com` }],
      sender: [{ name: longName, address: `${'s'.repeat(600)}@service.io` }],
    }));
    for (const field of ['messageId', 'fromEmail', 'senderName', 'senderEmail']) {
      expect(p[field].length, field).toBeLessThanOrEqual(MAX_HEADER_FIELD);
    }
    expect(p.messageId).toBe(huge.slice(0, MAX_HEADER_FIELD));
  });
});

// The columns are the point, so check against PostgreSQL itself when a database is supplied.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('capped fields fit the real column types', () => {
  let database;
  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`CREATE TEMP TABLE m (message_id VARCHAR(500), from_name VARCHAR(500),
      from_email VARCHAR(500), sender_name VARCHAR(500), sender_email VARCHAR(500))`);
  });
  afterAll(async () => { await database?.end(); });

  it('inserts what parseMessage returns, and the raw values are what failed before', async () => {
    const p = await parseMessage(msg({
      messageId: `<${'m'.repeat(900)}@example.com>`,
      from: [{ name: emojiAtEdge, address: 'invites@example.com' }],
      sender: [{ name: longName, address: `${'s'.repeat(600)}@service.io` }],
    }));
    await database.query('INSERT INTO m VALUES ($1,$2,$3,$4,$5)',
      [p.messageId, p.fromName, p.fromEmail, p.senderName, p.senderEmail]);
    await expect(database.query('INSERT INTO m (from_name) VALUES ($1)', [longName]))
      .rejects.toThrow(/value too long for type character varying\(500\)/);
  });
});

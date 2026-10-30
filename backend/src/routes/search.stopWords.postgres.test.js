import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import express from 'express';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'owner' }; next(); } }));
import routes, { freeTextTermCondition } from './search.js';
import { query } from '../services/db.js';

// All fixtures are connection-local temporary tables in an explicitly supplied database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('stop-word body search PostgreSQL', () => {
  let database, server, base;
  async function search(q, scope = {}) {
    const response = await fetch(`${base}/?${new URLSearchParams({ q, ...scope })}`);
    expect(response.status).toBe(200);
    return (await response.json()).messages.map(message => message.id).sort();
  }
  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`
      CREATE TEMP TABLE email_accounts (id text, user_id text, enabled boolean,
        include_in_unified_inbox boolean, name text, email_address text, color text);
      CREATE TEMP TABLE folders (account_id text, path text, special_use text, name text);
      CREATE TEMP TABLE messages (id text, account_id text DEFAULT 'main', folder text DEFAULT 'INBOX',
        uid bigint, message_id text, subject text DEFAULT 'Status', from_name text DEFAULT 'Sender',
        from_email text DEFAULT 'sender@example.test', to_addresses jsonb, cc_addresses jsonb, reply_to jsonb, delivery_addresses jsonb, thread_id text,
        in_reply_to text, thread_references text, date timestamptz DEFAULT now(), snippet text,
        is_read boolean, is_starred boolean, has_attachments boolean, is_deleted boolean DEFAULT false,
        search_vector tsvector, body_text text);
      INSERT INTO email_accounts VALUES
        ('main','owner',true,true,'Primary','owner@example.test',NULL),
        ('other','stranger',true,true,'Other','other@example.test',NULL),
        ('excluded','owner',true,false,'Excluded','excluded@example.test',NULL),
        ('disabled','owner',false,true,'Disabled','disabled@example.test',NULL);
      INSERT INTO folders VALUES ('main','Trash','\\Trash','Trash');
      INSERT INTO messages(id,body_text) VALUES ('body','How are we doing Orion?'),
        ('unrelated','Orion runners run swiftly.'), ('null',NULL), ('empty','');
      INSERT INTO messages(id,subject,body_text) VALUES ('split','Orion','How are we doing?'),
        ('substring','Weaver somewhere',''), ('punctuation','!!!','');
      INSERT INTO messages(id,account_id,body_text) VALUES
        ('foreign','other','How are we doing Orion?'),
        ('opted-out','excluded','How are we doing Orion?'),
        ('disabled','disabled','How are we doing Orion?');
      INSERT INTO messages(id,folder,body_text) VALUES ('trash','Trash','How are we doing Orion?');
      INSERT INTO messages(id,is_deleted,body_text) VALUES ('deleted',true,'How are we doing Orion?');
      INSERT INTO messages(id,search_vector) VALUES ('vector',to_tsvector('english','nebula'));
    `);
    query.mockImplementation((sql, values) => database.query(sql, values));
    const app = express();
    app.use(routes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await database?.end();
  });

  it('matches every word across hydrated bodies and metadata within the authorized scope', async () => {
    expect(await search('how are we doing Orion')).toEqual(['body', 'split']);
    expect(await search('how are we doing Orion', { accountId: 'other' })).toEqual(['body', 'split']);
    expect(await search('how are we doing Orion', { accountId: 'excluded' })).toEqual(['opted-out']);
    expect(await search('how are we doing Orion', { folder: 'Trash' })).toEqual(['trash']);
    expect(await search('in:trash how are we doing Orion')).toEqual(['trash']);
  });

  it('requires positive stop words and excludes negative stop words only when present', async () => {
    expect(await search('we')).toEqual(['body', 'split', 'substring']);
    expect(await search('Orion -we')).toEqual(['unrelated']);
    expect(await search('Orion -the')).toEqual(['body', 'split', 'unrelated']);
    expect(await search('-we')).toEqual(['empty', 'null', 'punctuation', 'unrelated', 'vector']);
  });

  it('retains English stemming, stored vectors and metadata substring matching', async () => {
    expect(await search('running')).toEqual(['unrelated']);
    expect(await search('nebula')).toEqual(['vector']);
    expect(await search('where')).toEqual(['substring']);
    expect(await search('sender@exam')).toEqual(['body', 'empty', 'null', 'punctuation', 'split', 'substring', 'unrelated', 'vector']);
  });

  it('does not turn empty dictionaries into body wildcards', async () => {
    expect(await search('???')).toEqual([]);
    expect(await search('!!!')).toEqual(['punctuation']);
    expect(await search('Orion -???')).toEqual(['body', 'split', 'unrelated']);
  });

  it('keeps English stemming when a term contains both stop words and significant words', async () => {
    const result = await database.query(`SELECT ${freeTextTermCondition(1, 2)} AS matched FROM
      (SELECT ''::text AS from_name, ''::text AS from_email, ''::text AS subject,
        ''::tsvector AS search_vector, 'runs swiftly'::text AS body_text) m`,
    ['%the running%', 'the running']);
    expect(result.rows[0].matched).toBe(true);
  });

  it('caps simple-dictionary matching at the same character boundary as English', async () => {
    const condition = freeTextTermCondition(1, 2);
    for (const [padding, expected] of [[599997, true], [599998, false], [600000, false]]) {
      const result = await database.query(`SELECT ${condition} AS matched FROM
        (SELECT ''::text AS from_name, ''::text AS from_email, ''::text AS subject,
          ''::tsvector AS search_vector, repeat('界', $3::int) || ' we ' AS body_text) m`,
      ['%we%', 'we', padding]);
      expect(result.rows[0].matched, String(padding)).toBe(expected);
    }
  });

  it('agrees with literal stop-word membership and its complement for generated bodies', async () => {
    let seed = 0x51a7;
    const draw = n => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
    const words = ['we', 'are', 'how', 'the', 'and', 'theory', 'candy', 'often', 'orion', 'quartz'];
    const condition = freeTextTermCondition(1, 2);
    for (let i = 0; i < 80; i++) {
      const term = words[draw(5)];
      const tokens = Array.from({ length: draw(20) }, () => words[draw(words.length)]);
      const body = i === 0 ? null : tokens.map(word => draw(2) ? word.toUpperCase() : word).join(' , ');
      const result = await database.query(`SELECT ${condition} AS positive,
        NOT coalesce(${condition},false) AS negative FROM
        (SELECT NULL::text AS from_name, NULL::text AS from_email, NULL::text AS subject,
          NULL::tsvector AS search_vector, $3::text AS body_text) m`, [`%${term}%`, term, body]);
      const present = body !== null && tokens.includes(term);
      // Absent body matches may be SQL NULL through nullable metadata; route negation coalesces it.
      expect(result.rows[0].positive === true, JSON.stringify({ i, term, body })).toBe(present);
      expect(result.rows[0].negative).toBe(!present);
    }
  });
});

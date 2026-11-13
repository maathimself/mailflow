import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { freeTextTermCondition } from '../routes/search.js';
import { backfillMessageSearch, BACKFILL_SETTING } from './messageSearchBackfill.js';

const migration = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../migrations/0080_message_search.sql'), 'utf8');
const M1 = '00000000-0000-4000-8000-0000000000c1';
const M2 = '00000000-0000-4000-8000-0000000000c2';
const M3 = '00000000-0000-4000-8000-0000000000c3';

// Runs the real migration in a throwaway schema of an explicitly supplied database (D#320).
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('message_search (PostgreSQL)', () => {
  let db;
  const schema = `message_search_test_${process.pid}`;
  const q = (sql, params) => db.query(sql, params);
  const text = async html => (await q('SELECT mf_html_to_text($1) AS t', [html])).rows[0].t;
  const stored = async id => (await q('SELECT body_text FROM message_search WHERE message_id = $1', [id])).rows[0]?.body_text;
  const matches = async (id, term) => (await q(
    `SELECT ${freeTextTermCondition(1, 2)} AS matched FROM messages m WHERE m.id = $3`, [`%${term}%`, term, id],
  )).rows[0].matched === true;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await db.connect();
    await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}; SET search_path TO ${schema}, public`);
    await q(`
      CREATE TABLE system_settings (key text PRIMARY KEY, value text, updated_at timestamptz);
      CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), from_name text, from_email text,
        subject text, search_vector tsvector, body_html text, body_text text)`);
    await q(migration);
    await q(migration); // idempotent: the runner may replay it
  });
  beforeEach(async () => { await q('DELETE FROM messages; DELETE FROM system_settings'); });
  afterAll(async () => {
    await db?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db?.end();
  });

  it('keeps the readable text of an HTML body and drops head, style, script and comments', async () => {
    const html = `<html><HEAD><title>Alert</title><style>.x{color:red}</style></HEAD>
      <body><!-- tracking --><STYLE type="text/css">td{font-family:arial}</STYLE>
      <p>Truck <b>5037</b> exited &quot;YARD&quot; &amp; left&nbsp;at 8:47AM</p>
      <script>var secret = 1;</script><p>Second &lt;line&gt; &#8217;s &hellip;</p></body></html>`;
    expect(await text(html)).toBe('Truck 5037 exited "YARD" & left at 8:47AM Second <line> s');
  });

  it('removes each style block on its own, keeping the text between them', async () => {
    expect(await text('<style>a{}</style>kept<style>b{}</style>also')).toBe('kept also');
  });

  it('keeps an unterminated block as text, and caps the length', async () => {
    expect(await text('before<style>never closed text')).toBe('before never closed text');
    expect((await text(`<p>${'word '.repeat(200000)}</p>`)).length).toBe(600000);
    expect(await text(null)).toBeNull();
  });

  it('stays fast on hostile input', async () => {
    for (const html of [
      '<'.repeat(400000), '<style'.repeat(80000), '<style>'.repeat(80000), '<style></style>'.repeat(40000),
      '<!--'.repeat(100000), '<!---->'.repeat(80000), '<!-- -'.repeat(80000), `<a ${'"'.repeat(300000)}`,
      '&#'.repeat(200000), `<head>${'<h'.repeat(150000)}`, `<script>${'</scrip'.repeat(60000)}`,
    ]) {
      const started = Date.now();
      await text(html);
      expect(Date.now() - started, html.slice(0, 12)).toBeLessThan(3000);
    }
  });

  it('fills, refills and clears the row as the body is written', async () => {
    await q('INSERT INTO messages (id, body_html) VALUES ($1, $2)', [M1, '<p>Truck 5037 exited</p>']);
    expect(await stored(M1)).toBe('Truck 5037 exited');
    await q('INSERT INTO messages (id, body_html, body_text) VALUES ($1, $2, $3)', [M2, '<p>x</p>', 'plain']);
    expect(await stored(M2)).toBeUndefined();

    await q('UPDATE messages SET body_html = $2 WHERE id = $1', [M1, '<p>Truck 6120 entered</p>']);
    expect(await stored(M1)).toBe('Truck 6120 entered');
    await q('UPDATE messages SET body_text = $2 WHERE id = $1', [M1, 'now has plain text']);
    expect(await stored(M1)).toBeUndefined();
    await q('UPDATE messages SET body_text = NULL WHERE id = $1', [M1]);
    expect(await stored(M1)).toBe('Truck 6120 entered');
  });

  it('follows the row to a new id and goes with it on delete', async () => {
    await q('INSERT INTO messages (id, body_html) VALUES ($1, $2)', [M1, '<p>moved to trash</p>']);
    await q('UPDATE messages SET id = $2 WHERE id = $1', [M1, M3]);
    expect(await stored(M1)).toBeUndefined();
    expect(await stored(M3)).toBe('moved to trash');
    await q('DELETE FROM messages WHERE id = $1', [M3]);
    expect((await q('SELECT count(*)::int AS n FROM message_search')).rows[0].n).toBe(0);
  });

  it('lets search find a word deep in an HTML-only body, as it does in plain text', async () => {
    const filler = 'Daily fleet report for all vehicles in the northern district. '.repeat(7);
    await q('INSERT INTO messages (id, body_html) VALUES ($1, $2)', [M1, `<p>${filler}</p><p>Truck <b>7722</b> exited</p>`]);
    await q('INSERT INTO messages (id, body_text) VALUES ($1, $2)', [M2, `${filler} Truck 6611 exited`]);
    expect(await matches(M1, '7722')).toBe(true);
    expect(await matches(M2, '6611')).toBe(true);
    expect(await matches(M1, '6611')).toBe(false);
    // body_text wins when a message has both, so its HTML is not searched twice.
    await q('UPDATE messages SET body_html = $2 WHERE id = $1', [M2, '<p>only in html 9090</p>']);
    expect(await matches(M2, '9090')).toBe(false);
  });

  it('backfills HTML-only rows written before the migration, once', async () => {
    await q('ALTER TABLE messages DISABLE TRIGGER messages_search_sync');
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const { rows } = await q('INSERT INTO messages (body_html) VALUES ($1) RETURNING id', [`<p>old ${i}</p>`]);
      ids.push(rows[0].id);
    }
    await q('INSERT INTO messages (id, body_html, body_text) VALUES ($1, $2, $3)', [M2, '<p>x</p>', 'plain']);
    await q('ALTER TABLE messages ENABLE TRIGGER messages_search_sync');

    const first = await backfillMessageSearch({ query: q, batchSize: 2, pauseMs: 0 });
    expect(first).toEqual({ filled: 5, skipped: false });
    for (const [i, id] of ids.entries()) expect(await stored(id)).toBe(`old ${i}`);
    expect(await stored(M2)).toBeUndefined();
    expect((await q('SELECT value FROM system_settings WHERE key = $1', [BACKFILL_SETTING])).rows[0].value).toBe('true');
    expect(await backfillMessageSearch({ query: q, batchSize: 2, pauseMs: 0 })).toEqual({ filled: 0, skipped: true });
  });
});

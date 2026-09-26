import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

// Same mock surface the other mail.* route tests use so importing mail.js is side-effect free.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
vi.mock('../index.js', () => ({ imapManager: {} }));

import { RELOCATE_INSERT_COLS, RELOCATE_SELECT_COLS } from './mail.js';

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);

// messages columns the relocate reinsert deliberately does not carry from the deleted row.
// Every other column must be in RELOCATE_COPY_COLS, or a relocate resets it to its default.
const RELOCATE_EXCLUDED = new Set([
  // Column defaults: a fresh UUID and timestamp, the historical "row gets a new id on move".
  'id',
  'synced_at',
  // GENERATED ALWAYS: inserting any explicit value, even NULL, errors.
  'normalized_subject',
  'search_vector',
  'thread_key',
  // Never carried, before or since the shared list. It mirrors an inbox rule's \Deleted on the
  // source copy; the reinserted row is a message UIDPLUS just placed, so it starts false.
  'is_deleted',
  // Snippet indexer bookkeeping, also never carried. Resetting it costs at most one more
  // snippet fetch for a moved row that has none.
  'snippet_attempted_at',
]);

const TABLE_CONSTRAINT = /^(constraint|primary|unique|check|foreign|exclude)$/i;

// The messages columns the migrations leave behind: the baseline CREATE TABLE, then every
// ALTER TABLE messages ADD / DROP COLUMN, applied in file order. Only the spelled-out COLUMN
// form is recognised, which is the form every migration so far uses.
function messagesColumnsFromMigrations() {
  const cols = new Set();
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8').replace(/--[^\n]*/g, '');
    const create = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?messages\s*\(([\s\S]*?)\n\);/i);
    if (create) {
      for (const line of create[1].split('\n')) {
        const name = line.trim().match(/^\w+/)?.[0];
        if (name && !TABLE_CONSTRAINT.test(name)) cols.add(name.toLowerCase());
      }
    }
    for (const [, body] of sql.matchAll(/ALTER\s+TABLE\s+messages\s([^;]*);/gi)) {
      for (const [, op, name] of body.matchAll(/\b(ADD|DROP)\s+COLUMN\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(\w+)/gi)) {
        if (op.toUpperCase() === 'ADD') cols.add(name.toLowerCase());
        else cols.delete(name.toLowerCase());
      }
    }
  }
  return cols;
}

// Guards the DELETE + reinsert CTE column lists shared by bulk trash / move / archive. The list
// is hand-maintained and has gone stale twice, each time silently resetting the columns a later
// migration added (delivery_addresses/plugin_annotations/sender_* in 0037/0044/0050, then
// forwarded_from_*/forwarded_via in 0059).
describe('relocate reinsert column lists', () => {
  const insertCols = RELOCATE_INSERT_COLS.split(',').map(s => s.trim());
  const selectCols = RELOCATE_SELECT_COLS.split(',').map(s => s.trim());
  const schemaCols = messagesColumnsFromMigrations();

  it('INSERT and SELECT projections have matching arity', () => {
    expect(insertCols.length).toBe(selectCols.length);
  });

  it('reads the messages schema out of the migrations', () => {
    // Baseline CREATE TABLE, single ALTER, multi-clause ALTER, and a column added then dropped.
    for (const col of ['subject', 'reply_to', 'spam_details', 'forwarded_via']) {
      expect(schemaCols).toContain(col);
    }
    expect(schemaCols).not.toContain('gtd_gist');
  });

  it('carries every messages column the migrations add, apart from the explicit exclusions', () => {
    const dropped = [...schemaCols].filter(c => !insertCols.includes(c) && !RELOCATE_EXCLUDED.has(c));
    expect(dropped).toEqual([]);
  });

  it('lists only real columns, and never inserts an excluded one', () => {
    expect(insertCols.filter(c => !schemaCols.has(c))).toEqual([]);
    expect([...RELOCATE_EXCLUDED].filter(c => !schemaCols.has(c))).toEqual([]);
    expect(insertCols.filter(c => RELOCATE_EXCLUDED.has(c))).toEqual([]);
  });

  it('binds destination uid/folder and copies every other column verbatim from the deleted row', () => {
    expect(insertCols.slice(0, 3)).toEqual(['account_id', 'uid', 'folder']);
    expect(selectCols.slice(0, 3)).toEqual(['d.account_id', 'u.new_uid', '$4']);
    for (let i = 3; i < insertCols.length; i++) {
      expect(selectCols[i]).toBe(`d.${insertCols[i]}`);
    }
    expect(new Set(insertCols).size).toBe(insertCols.length); // no duplicate columns
  });
});

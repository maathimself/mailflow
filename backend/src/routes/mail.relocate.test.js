import { describe, it, expect, vi } from 'vitest';

// Same mock surface the other mail.* route tests use so importing mail.js is side-effect free.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
vi.mock('../index.js', () => ({ imapManager: {} }));

import { RELOCATE_INSERT_COLS, RELOCATE_SELECT_COLS } from './mail.js';

// Guards the DELETE + reinsert CTE column lists shared by bulk trash / move / archive. The
// original bug: an explicit column list went stale and silently dropped columns added by later
// migrations (delivery_addresses/plugin_annotations/sender_*). These assertions fail if the
// INSERT/SELECT projections drift out of correspondence or drop the columns that regressed.
describe('relocate reinsert column lists', () => {
  const insertCols = RELOCATE_INSERT_COLS.split(',').map(s => s.trim());
  const selectCols = RELOCATE_SELECT_COLS.split(',').map(s => s.trim());

  it('INSERT and SELECT projections have matching arity', () => {
    expect(insertCols.length).toBe(selectCols.length);
  });

  it('carries the columns that previously went stale (migrations 0037/0044/0050)', () => {
    for (const col of ['delivery_addresses', 'plugin_annotations', 'sender_name', 'sender_email']) {
      expect(insertCols).toContain(col);
      expect(selectCols).toContain(`d.${col}`);
    }
  });

  it('never inserts id, synced_at, or GENERATED columns (would regress id / error)', () => {
    for (const col of ['id', 'synced_at', 'normalized_subject', 'search_vector', 'thread_key']) {
      expect(insertCols).not.toContain(col);
    }
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

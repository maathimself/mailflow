import { describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
import { backfillMessageSearch, BACKFILL_SETTING } from './messageSearchBackfill.js';

// A fake database: `pending` is the id-ordered list of HTML-only rows not yet indexed.
function fakeDb({ done = false, pending = [] } = {}) {
  const calls = [];
  const query = vi.fn(async (sql, params) => {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT value FROM system_settings')) return { rows: done ? [{ value: 'true' }] : [] };
    if (sql.includes('SELECT id FROM messages')) {
      const [after, limit] = params;
      return { rows: pending.filter(id => id > after).slice(0, limit).map(id => ({ id })) };
    }
    if (sql.includes('INSERT INTO message_search')) return { rowCount: params[0].length };
    return { rows: [], rowCount: 1 };
  });
  return { query, calls };
}

describe('backfillMessageSearch', () => {
  it('does nothing once it has finished', async () => {
    const { query, calls } = fakeDb({ done: true });
    expect(await backfillMessageSearch({ query })).toEqual({ filled: 0, skipped: true });
    expect(calls).toHaveLength(1);
  });

  it('walks the rows in id order, a batch at a time with a pause, then records that it finished', async () => {
    const ids = ['a1', 'a2', 'b1', 'b2', 'c1'];
    const { query, calls } = fakeDb({ pending: ids });
    const sleep = vi.fn(async () => {});
    expect(await backfillMessageSearch({ query, batchSize: 2, pauseMs: 7, sleep })).toEqual({ filled: 5, skipped: false });
    const inserts = calls.filter(c => c.sql.includes('INSERT INTO message_search')).map(c => c.params[0]);
    expect(inserts).toEqual([['a1', 'a2'], ['b1', 'b2'], ['c1']]);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(7);
    const last = calls.at(-1);
    expect(last.sql).toContain('INSERT INTO system_settings');
    expect(last.params).toEqual([BACKFILL_SETTING]);
  });

  it('records that it finished when there is nothing to fill', async () => {
    const { query, calls } = fakeDb();
    expect(await backfillMessageSearch({ query })).toEqual({ filled: 0, skipped: false });
    expect(calls.at(-1).sql).toContain('INSERT INTO system_settings');
  });

  it('does not record a finish when a batch fails, so the next start tries again', async () => {
    const { query, calls } = fakeDb({ pending: ['a1'] });
    query.mockImplementationOnce(async () => ({ rows: [] }))
      .mockImplementationOnce(async () => { throw new Error('connection lost'); });
    await expect(backfillMessageSearch({ query })).rejects.toThrow('connection lost');
    expect(calls.some(c => c.sql.includes('INSERT INTO system_settings'))).toBe(false);
  });
});

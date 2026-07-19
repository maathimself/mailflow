import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => ({
  query: vi.fn(),
  pool: { connect: vi.fn() },
}));
vi.mock('../backgroundJobs.js', () => ({ upsertJob: vi.fn() }));

import { pool, query } from '../db.js';
import { upsertJob } from '../backgroundJobs.js';
import { runFtsBackfill } from './ftsBackfill.js';

const noSleep = () => Promise.resolve();

function mockCountClient({ remaining = 0, error = null, gate = null } = {}) {
  const client = {
    query: vi.fn(async (sql) => {
      if (/SELECT count\(\*\)/.test(sql)) {
        if (gate) await gate;
        if (error) throw error;
        return { rows: [{ remaining }] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  pool.connect.mockResolvedValueOnce(client);
  return client;
}

beforeEach(() => {
  query.mockReset();
  pool.connect.mockReset();
  upsertJob.mockReset();
});

describe('runFtsBackfill', () => {
  it('counts stale rows with transaction-local statement_timeout disabled', async () => {
    const client = mockCountClient({ remaining: 0 });
    // Compatibility response for the old implementation. The new path must not use it.
    query.mockResolvedValueOnce({ rows: [{ remaining: 0 }] });

    await runFtsBackfill({ sleep: noSleep });

    expect(pool.connect).toHaveBeenCalledOnce();
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'SET LOCAL statement_timeout = 0',
      expect.stringContaining('SELECT count(*)::int AS remaining'),
      'COMMIT',
    ]);
    expect(client.release).toHaveBeenCalledOnce();
    expect(query).not.toHaveBeenCalled();
    expect(upsertJob).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fts_backfill', state: 'done' }));
  });

  it('rolls back and releases the count client when the count fails', async () => {
    const countError = new Error('count failed');
    const client = mockCountClient({ error: countError });
    query.mockRejectedValueOnce(countError);

    await expect(runFtsBackfill({ sleep: noSleep })).rejects.toThrow('count failed');

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'SET LOCAL statement_timeout = 0',
      expect.stringContaining('SELECT count(*)::int AS remaining'),
      'ROLLBACK',
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('drains in batches until an UPDATE affects zero rows, reporting progress', async () => {
    mockCountClient({ remaining: 5000 });
    query
      .mockResolvedValueOnce({ rowCount: 3000 })
      .mockResolvedValueOnce({ rowCount: 2000 })
      .mockResolvedValueOnce({ rowCount: 0 });

    await runFtsBackfill({ sleep: noSleep });

    const batchSql = query.mock.calls[0][0];
    expect(batchSql).toContain('fts_version IS DISTINCT FROM 1');
    expect(batchSql).toContain("setweight(to_tsvector('english', coalesce(m.subject,'')), 'A')");
    expect(upsertJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'done', processed: 5000, total: 5000 })
    );
  });

  it('is single-flight: a second concurrent call returns immediately', async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    mockCountClient({ remaining: 0, gate });

    const first = runFtsBackfill({ sleep: noSleep });
    await runFtsBackfill({ sleep: noSleep });
    release();
    await first;

    expect(pool.connect).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
// Mock inline + import the mocked bindings (avoids the vi.mock hoisting TDZ trap).
vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('../backgroundJobs.js', () => ({ upsertJob: vi.fn() }));
import { query } from '../db.js';
import { upsertJob } from '../backgroundJobs.js';
import { runFtsBackfill } from './ftsBackfill.js';

const noSleep = () => Promise.resolve();
beforeEach(() => { query.mockReset(); upsertJob.mockReset(); });

describe('runFtsBackfill', () => {
  it('marks the job done and does no work when nothing is stale', async () => {
    query.mockResolvedValueOnce({ rows: [{ remaining: 0 }] }); // count
    await runFtsBackfill({ sleep: noSleep });
    expect(query).toHaveBeenCalledTimes(1); // count only, no batch UPDATE
    expect(upsertJob).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fts_backfill', state: 'done' }));
  });

  it('drains in batches until an UPDATE affects zero rows, reporting progress', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ remaining: 5000 }] }) // count
      .mockResolvedValueOnce({ rowCount: 3000 })              // batch 1
      .mockResolvedValueOnce({ rowCount: 2000 })              // batch 2
      .mockResolvedValueOnce({ rowCount: 0 });                // batch 3 → stop
    await runFtsBackfill({ sleep: noSleep });
    const batchSql = query.mock.calls[1][0];
    expect(batchSql).toContain('fts_version IS DISTINCT FROM 1');
    expect(batchSql).toContain("setweight(to_tsvector('english', coalesce(m.subject,'')), 'A')");
    expect(upsertJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'done', processed: 5000, total: 5000 })
    );
  });

  it('is single-flight: a second concurrent call returns immediately', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    query.mockImplementationOnce(async () => { await gate; return { rows: [{ remaining: 0 }] }; });
    const first = runFtsBackfill({ sleep: noSleep });
    await runFtsBackfill({ sleep: noSleep }); // returns immediately (guarded)
    release();
    await first;
    expect(query).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('./db.js', () => ({ query: vi.fn() }));
import { query } from './db.js';
import { upsertJob, listJobs } from './backgroundJobs.js';

beforeEach(() => query.mockReset());

describe('backgroundJobs', () => {
  it('upserts one row per (kind, account) via the COALESCE unique index', async () => {
    query.mockResolvedValue({ rows: [] });
    await upsertJob({ kind: 'fts_backfill', state: 'running', processed: 10, total: 100 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO background_jobs');
    expect(sql).toContain("ON CONFLICT (kind, COALESCE(account_id::text, ''))");
    expect(sql).toContain('started_at = COALESCE(background_jobs.started_at, EXCLUDED.started_at)');
    expect(params).toEqual(['fts_backfill', null, 'running', 10, 100, null]);
  });

  it('lists jobs newest-first', async () => {
    query.mockResolvedValue({ rows: [{ kind: 'fts_backfill' }] });
    const jobs = await listJobs();
    expect(jobs).toEqual([{ kind: 'fts_backfill' }]);
    expect(query.mock.calls[0][0]).toContain('ORDER BY updated_at DESC');
  });
});

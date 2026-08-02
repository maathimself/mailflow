import { describe, it, expect, vi, beforeEach } from 'vitest';

// generationByState feeds get_stats' active/building generation summaries. It must
// SELECT the epoch-seconds timestamp columns those summaries emit — activated_at
// (active) and started_at (building) — or vectorStats only ever sees undefined and
// the wire fields collapse to "". (Same family as the chunkCount gap.)
vi.mock('../db.js', () => ({ pool: { query: vi.fn() }, withTransaction: vi.fn() }));
import { pool } from '../db.js';
import { activeGeneration, buildingGeneration } from './generations.js';

beforeEach(() => { pool.query.mockReset(); });

describe('generationByState surfaces the timestamp columns get_stats emits', () => {
  it('activeGeneration SELECTs activated_at + started_at (camelCase) and returns them', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{
      id: 1, model: 'm', dimension: 4, fingerprint: 'f', state: 'active',
      messageCount: 5, activatedAt: 1784235357, startedAt: 1784200000,
    }] });
    const g = await activeGeneration();
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/activated_at AS "activatedAt"/);
    expect(sql).toMatch(/started_at AS "startedAt"/);
    expect(params).toEqual(['active']);
    expect(g.activatedAt).toBe(1784235357);
    expect(g.startedAt).toBe(1784200000);
  });

  it('buildingGeneration uses the same SELECT so started_at is surfaced', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{
      id: 2, model: 'm', dimension: 4, fingerprint: 'f', state: 'building',
      messageCount: 0, startedAt: 1784200000,
    }] });
    const g = await buildingGeneration();
    expect(pool.query.mock.calls[0][0]).toMatch(/started_at AS "startedAt"/);
    expect(pool.query.mock.calls[0][1]).toEqual(['building']);
    expect(g.startedAt).toBe(1784200000);
  });
});

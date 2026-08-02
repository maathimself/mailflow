import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit-pin generations.chunkCount, the seam get_stats' collectStats calls for
// active_generation.message_count and the building generation's progress.done.
// It was listed in the frozen cross-phase contract but never implemented in the
// real module (only ever a vi.fn() in test mocks) — so live collectStats threw
// "generations.chunkCount is not a function" and the vector_search block vanished.
vi.mock('../db.js', () => ({ pool: { query: vi.fn() }, withTransaction: vi.fn() }));
import { pool } from '../db.js';
import * as generations from './generations.js';

beforeEach(() => { pool.query.mockReset(); });

describe('generations.chunkCount (msgvault Stats.EmbeddingCount semantics)', () => {
  it('counts DISTINCT message_id (not chunk rows) scoped to the generation, returned as a number', async () => {
    // msgvault: "EmbeddingCount is distinct messages, not chunk rows". Live parity:
    // 18,193 chunk rows / 18,192 distinct messages → message_count 18,192.
    pool.query.mockResolvedValueOnce({ rows: [{ n: '18192' }] });
    const n = await generations.chunkCount(7);
    expect(n).toBe(18192);
    expect(typeof n).toBe('number');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/COUNT\(\s*DISTINCT\s+message_id\s*\)/i);
    expect(sql).not.toMatch(/COUNT\(\s*\*\s*\)/); // raw chunk rows would inflate message_count
    expect(sql).toMatch(/FROM\s+embeddings/i);
    expect(sql).toMatch(/generation_id\s*=\s*\$1/);
    expect(params).toEqual([7]);
  });
});

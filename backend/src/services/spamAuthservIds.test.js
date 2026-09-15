import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

import { query } from './db.js';
import { detectAuthservIds } from './spamAuthservIds.js';

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});

describe('detectAuthservIds', () => {
  it('counts ids across the scanned messages, most frequent first', async () => {
    query.mockResolvedValueOnce({
      rows: [
        { spam_details: { authservIds: ['mx.example.com'] } },
        { spam_details: { authservIds: ['mx.example.com'] } },
        { spam_details: { authservIds: ['attacker.invalid', 'mx.example.com'] } },
      ],
    });

    const result = await detectAuthservIds(ACCOUNT_ID);
    expect(result.analyzed).toBe(3);
    expect(result.detected).toEqual([
      { id: 'mx.example.com', count: 3 },
      { id: 'attacker.invalid', count: 1 },
    ]);
  });

  it('parses spam_details stored as a JSON string', async () => {
    query.mockResolvedValueOnce({
      rows: [{ spam_details: JSON.stringify({ authservIds: ['mx.example.com'] }) }],
    });
    const result = await detectAuthservIds(ACCOUNT_ID);
    expect(result.detected).toEqual([{ id: 'mx.example.com', count: 1 }]);
  });

  it('ignores rows without an authservIds array and malformed JSON', async () => {
    query.mockResolvedValueOnce({
      rows: [
        { spam_details: { method: 'rules' } },
        { spam_details: { authservIds: 'mx.example.com' } },
        { spam_details: '{not json' },
        { spam_details: null },
      ],
    });
    const result = await detectAuthservIds(ACCOUNT_ID);
    expect(result.detected).toEqual([]);
    expect(result.analyzed).toBe(4);
  });

  it('returns no data when nothing was classified yet', async () => {
    const result = await detectAuthservIds(ACCOUNT_ID);
    expect(result).toEqual({ analyzed: 0, detected: [] });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM messages'), [ACCOUNT_ID, 200]);
  });

  it('bounds the limit to 1..500 and reports at most 5 ids', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await detectAuthservIds(ACCOUNT_ID, { limit: 10_000 });
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('FROM messages'), [ACCOUNT_ID, 500]);

    query.mockResolvedValueOnce({
      rows: Array.from({ length: 8 }, (_, i) => ({ spam_details: { authservIds: [`id${i}.test`] } })),
    });
    const result = await detectAuthservIds(ACCOUNT_ID, { limit: 0 });
    expect(result.detected).toHaveLength(5);
    expect(result.analyzed).toBe(8);
  });
});

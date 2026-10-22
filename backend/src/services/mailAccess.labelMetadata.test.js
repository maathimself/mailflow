import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
import { query } from './db.js';
import { getLabelMetadata } from './mailAccess.js';

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';

beforeEach(() => query.mockReset());

describe('getLabelMetadata', () => {
  it('maps requested rows to live same-thread label folders', async () => {
    query.mockResolvedValueOnce({ rows: [
      { message_id: M1, folder: 'Todo', date: new Date('2026-08-01T00:00:00.000Z') },
      { message_id: M2, folder: 'Watch', date: new Date('2026-07-01T00:00:00.000Z') },
    ] });

    const result = await getLabelMetadata(ACCOUNT, [M1, M2], ['Todo', 'Watch']);

    expect(result).toEqual([
      { messageId: M1, folder: 'Todo', date: '2026-08-01T00:00:00.000Z' },
      { messageId: M2, folder: 'Watch', date: '2026-07-01T00:00:00.000Z' },
    ]);
    const [, params] = query.mock.calls[0];
    expect(params).toEqual([ACCOUNT, [M1, M2], ['Todo', 'Watch']]);
  });

  it('returns no metadata without querying when ids or folders are empty', async () => {
    expect(await getLabelMetadata(ACCOUNT, [], ['Todo'])).toEqual([]);
    expect(await getLabelMetadata(ACCOUNT, [M1], [])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
  it('enforces the 100-row capability bound before querying', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(getLabelMetadata(ACCOUNT, Array(101).fill(M1), ['Todo'])).rejects.toThrow('100');
    expect(query).not.toHaveBeenCalled();
  });

});

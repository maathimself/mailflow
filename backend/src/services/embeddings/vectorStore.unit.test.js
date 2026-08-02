import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../db.js', () => ({ pool: {}, withTransaction: vi.fn() }));
import { withTransaction } from '../db.js';
import { vectorLiteral, searchWiden, stampSkipped } from './vectorStore.js';

describe('vectorLiteral', () => {
  it('formats a float vector as pgvector text', () => {
    expect(vectorLiteral([1, 2.5, -3.25])).toBe('[1,2.5,-3.25]');
  });
  it('emits an empty-brackets literal for an empty vector', () => {
    expect(vectorLiteral([])).toBe('[]');
  });
});

describe('searchWiden (A1 filtered early-exit)', () => {
  it('early-exits once distinctEarlyExit is reached (filtered path, one run)', async () => {
    const runs = [];
    const run = async (n) => { runs.push(n); return [{ messageId: 'a' }, { messageId: 'b' }]; };
    const hits = await searchWiden(5, 1000, 2, run); // k=5, ceiling=1000, earlyExit=2
    expect(runs).toEqual([20]);          // did NOT widen up to the 1000-chunk ceiling
    expect(hits.map((h) => h.rank)).toEqual([1, 2]);
  });

  it('widens by doubling until k distinct survive (no-filter: earlyExit=k)', async () => {
    const runs = [];
    const run = async (n) => { runs.push(n); return Array.from({ length: Math.min(Math.floor(n / 10), 5) }, (_, i) => ({ messageId: 'm' + i })); };
    const hits = await searchWiden(5, 100, 5, run);
    expect(runs).toEqual([20, 40, 80]);  // 2 < 5, 4 < 5, then 8 → sliced to 5
    expect(hits).toHaveLength(5);
  });

  it('stops at the ceiling even when k is never reached', async () => {
    const runs = [];
    const run = async (n) => { runs.push(n); return [{ messageId: 'only' }]; };
    const hits = await searchWiden(5, 30, 5, run);
    expect(runs).toEqual([20, 30]);      // clamps the doubled 40 to the 30 ceiling, then stops
    expect(hits).toHaveLength(1);
  });
});

describe('stampSkipped (Wave D Fix 7 — message_count decrement)', () => {
  beforeEach(() => { withTransaction.mockReset(); });

  function scriptedClient({ deletedDistinct = 2 } = {}) {
    const calls = [];
    const client = {
      calls,
      query: vi.fn(async (text, params) => {
        calls.push({ text, params });
        if (/FROM index_generations WHERE id = \$1 FOR UPDATE/.test(text)) return { rows: [{ id: params[0] }] };
        if (/^UPDATE messages SET embed_gen = \$1 WHERE id = \$2 AND/.test(text)) {
          return { rowCount: params[1] === 'cas-missed' ? 0 : 1 }; // CAS stamp
        }
        if (/COUNT\(DISTINCT message_id\)/.test(text)) return { rows: [{ n: deletedDistinct }] };
        return { rows: [], rowCount: 1 };
      }),
    };
    withTransaction.mockImplementation(async (fn) => fn(client));
    return client;
  }

  it('decrements message_count by the DISTINCT messages actually deleted, in the same tx, under the generation row lock', async () => {
    const client = scriptedClient({ deletedDistinct: 2 });
    const missed = await stampSkipped(9,
      [{ id: 'cas-ok', lastModified: 't1' }, { id: 'cas-missed', lastModified: 't2' }],
      ['plain-1']);
    expect(missed).toEqual(['cas-missed']);
    const texts = client.calls.map((c) => c.text);
    // Generation row locked FIRST — same lock order as upsert()/msgvault Delete.
    expect(texts[0]).toMatch(/SELECT id FROM index_generations WHERE id = \$1 FOR UPDATE/);
    // Vectors deleted only for ids whose stamp landed (CAS-missed keeps its vector)…
    const del = client.calls.find((c) => /DELETE FROM embeddings/.test(c.text));
    expect(del.params).toEqual([9, ['cas-ok', 'plain-1']]);
    // …counted BEFORE the delete, and the count decrements the generation.
    expect(texts.findIndex((t) => /COUNT\(DISTINCT message_id\)/.test(t)))
      .toBeLessThan(texts.findIndex((t) => /DELETE FROM embeddings/.test(t)));
    const upd = client.calls.find((c) => /UPDATE index_generations SET message_count = message_count - \$1/.test(c.text));
    expect(upd.params).toEqual([2, 9]);
  });

  it('skips the decrement when the stamped ids had no vectors to delete', async () => {
    const client = scriptedClient({ deletedDistinct: 0 });
    await stampSkipped(9, [{ id: 'cas-ok', lastModified: 't1' }], []);
    expect(client.calls.some((c) => /UPDATE index_generations SET message_count/.test(c.text))).toBe(false);
    expect(client.calls.some((c) => /DELETE FROM embeddings/.test(c.text))).toBe(true);
  });

  it('is a no-op (no transaction) for empty inputs', async () => {
    expect(await stampSkipped(9, [], [])).toEqual([]);
    expect(withTransaction).not.toHaveBeenCalled();
  });
});

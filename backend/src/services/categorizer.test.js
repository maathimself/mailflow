import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ completeText: vi.fn() }));

import { query } from './db.js';
import { completeText } from './aiProvider.js';
import { aiClassifyMessage, backfillCategories } from './categorizer.js';

beforeEach(() => {
  query.mockReset();
  completeText.mockReset();
});

describe('aiClassifyMessage provider adapter integration', () => {
  it.each(['primary', 'newsletter', 'promotion', 'automated', 'social'])(
    'accepts the exact supported category %s from completeText',
    async (category) => {
      completeText.mockResolvedValue(`  ${category.toUpperCase()}  `);
      await expect(aiClassifyMessage('Subject', 'sender@example.com', 'Preview'))
        .resolves.toBe(category);
      expect(completeText).toHaveBeenCalledWith([
        { role: 'user', content: expect.stringContaining('Subject: Subject') },
      ], { maxTokens: 1024 });
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each([
    'not-a-category',
    'This looks like a promotion',
    'primary or social',
    '',
    null,
  ])('rejects non-exact provider output %j', async (output) => {
    completeText.mockResolvedValue(output);
    await expect(aiClassifyMessage('Subject', 'sender@example.com', 'Preview'))
      .resolves.toBeNull();
  });

  it('returns null when the selected provider is unavailable or fails', async () => {
    completeText.mockRejectedValue(new Error('reconnect required'));
    await expect(aiClassifyMessage('Subject', 'sender@example.com', 'Preview'))
      .resolves.toBeNull();
  });

  it('never makes a provider-specific fetch outside the adapter', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    completeText.mockResolvedValue('primary');
    await aiClassifyMessage('Subject', 'sender@example.com', 'Preview');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

// ── backfillCategories paging ───────────────────────────────────────────────────────────
//
// The loop pages a result set that SHRINKS while it works: a row that receives a category
// leaves `category IS NULL`, while a row classified primary is left NULL and stays in. The
// fake store below models that faithfully, so these fail against OFFSET paging (which let
// one un-examined row escape for every row categorized) and pass against keyset paging.

// Ids are zero-padded so lexical order matches insertion order; only the total ordering
// matters here, not the specific values.
const mkRows = (n, bulkEvery) => Array.from({ length: n }, (_, i) => ({
  id: `msg-${String(i).padStart(5, '0')}`,
  from_email: `sender${i}@example.com`,
  is_bulk: bulkEvery > 0 && i % bulkEvery === 0, // bulkEvery 0 means never bulk
}));

function makeStore(rows) {
  const byId = new Map(rows.map(r => [r.id, { ...r, category: null }]));
  const seen = [];

  query.mockImplementation(async (sql, params) => {
    if (/FROM category_list_sources/.test(sql)) return { rows: [] };

    if (/SELECT id, from_email, is_bulk/.test(sql)) {
      const [, lastId, limit] = params;
      const page = [...byId.values()]
        .filter(r => r.category === null)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .filter(r => lastId === null || r.id > lastId)
        .slice(0, limit);
      page.forEach(r => seen.push(r.id));
      return { rows: page.map(r => ({ id: r.id, from_email: r.from_email, is_bulk: r.is_bulk })) };
    }

    if (/UPDATE messages SET category/.test(sql)) {
      const [ids, categories] = params;
      ids.forEach((id, i) => { byId.get(id).category = categories[i]; });
      return { rows: [] };
    }

    throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  });

  return { byId, seen };
}

const duplicatesIn = (ids) => ids.filter((id, i) => ids.indexOf(id) !== i);

describe('backfillCategories paging', () => {
  it('examines every uncategorized message exactly once while the set shrinks', async () => {
    // 1200 rows over a batch size of 500, half categorized as we go. Under OFFSET paging
    // the rows pushed past a window were silently never classified at all.
    const { seen } = makeStore(mkRows(1200, 2));

    const processed = await backfillCategories('acct-1', 'user-1');

    expect(duplicatesIn(seen)).toEqual([]);
    expect(seen.length).toBe(1200);
    expect(processed).toBe(1200);
  });

  it('leaves no bulk message uncategorized', async () => {
    const { byId } = makeStore(mkRows(1100, 3)); // every third row is bulk

    await backfillCategories('acct-1', 'user-1');

    const missed = [...byId.values()].filter(r => r.is_bulk && r.category !== 'newsletter');
    expect(missed.map(r => r.id)).toEqual([]);
  });

  it('terminates when the set never shrinks (everything classifies as primary)', async () => {
    // Nothing is ever updated, so a naive "always read the head" loop would spin forever.
    // The keyset cursor still advances past rows it has already seen.
    const { seen, byId } = makeStore(mkRows(1300, 0));

    const processed = await backfillCategories('acct-1', 'user-1');

    expect(processed).toBe(1300);
    expect(duplicatesIn(seen)).toEqual([]);
    expect([...byId.values()].every(r => r.category === null)).toBe(true);
  });

  it('pages with a keyset cursor, never an OFFSET', async () => {
    makeStore(mkRows(600, 2));
    await backfillCategories('acct-1', 'user-1');

    const selects = query.mock.calls.filter(c => /SELECT id, from_email, is_bulk/.test(c[0]));
    expect(selects.length).toBeGreaterThan(1);
    for (const [sql] of selects) {
      expect(sql).not.toMatch(/OFFSET/i);
      expect(sql).toMatch(/id > \$2/);
    }
    // First page starts with a null cursor, later pages carry the last id seen.
    expect(selects[0][1][1]).toBe(null);
    expect(selects[1][1][1]).toBe('msg-00499');
  });

  it('handles an empty account', async () => {
    const { seen } = makeStore([]);
    expect(await backfillCategories('acct-1', 'user-1')).toBe(0);
    expect(seen.length).toBe(0);
  });
});

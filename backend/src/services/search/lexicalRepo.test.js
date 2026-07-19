import { describe, it, expect, vi } from 'vitest';
import {
  FTS_BODY_CHAR_CAP,
  FTS_VERSION,
  negateCond,
  trashFolderExclusionCondition,
  freeTextTermCondition,
  searchFtsExpr,
  searchLexical,
  LEXICAL_RANK_SQL,
  freeTextTermConditionRanked,
  freeTextTermClause,
  negatedFreeTextClause,
  stopwordSafeCondition,
  buildOperatorClauses,
  buildFolderScopeClauses,
} from './lexicalRepo.js';

describe('SQL fragment builders', () => {
  it('pins the body cap at 600000 and FTS version at 1 (msgvault parity)', () => {
    expect(FTS_BODY_CHAR_CAP).toBe(600000);
    expect(FTS_VERSION).toBe(1);
  });

  it('caps the body tsvector inside the free-text condition', () => {
    const cond = freeTextTermCondition(3, 4);
    expect(cond).toContain(
      `to_tsvector('english', LEFT(coalesce(m.body_text,''), ${FTS_BODY_CHAR_CAP}))`
    );
    expect(cond).toContain('m.from_name ILIKE $3');
    expect(cond).toContain("m.search_vector @@ plainto_tsquery('english', $4)");
    expect(cond).not.toContain("to_tsvector('english', coalesce(m.body_text,'')) @@");
  });

  it('negateCond wraps a positive condition to also match NULL columns', () => {
    expect(negateCond('m.is_read = true')).toBe('NOT COALESCE((m.is_read = true), false)');
  });

  it('trashFolderExclusionCondition targets trash-like folders', () => {
    const sql = trashFolderExclusionCondition();
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('%trash%');
    expect(sql).toContain('%deleted%');
  });

  it('searchFtsExpr builds a weighted A/B/C/D tsvector for the given row alias', () => {
    const expr = searchFtsExpr('m');
    expect(expr).toContain("setweight(to_tsvector('english', coalesce(m.subject,'')), 'A')");
    expect(expr).toContain("coalesce(m.from_name,'') || ' ' || coalesce(m.from_email,'')");
    expect(expr).toContain("LEFT(coalesce(m.body_text,''), 600000)), 'D')");
    // NEW.-form for the trigger must be produced by the same builder.
    expect(searchFtsExpr('NEW')).toContain("coalesce(NEW.subject,'')");
  });
});

describe('searchLexical', () => {
  function mockClient() {
    const calls = [];
    const fn = vi.fn(async (text, params) => { calls.push({ text, params }); return { rows: [{ id: 'x' }] }; });
    return { fn, calls };
  }

  it('returns hasCondition:false and never queries when there is no real condition', async () => {
    const { fn } = mockClient();
    const res = await searchLexical(fn, {
      parsed: { filters: [{ key: 'in', value: 'inbox', negate: false }], terms: [] },
      accountIds: ['a1'], folderScope: 'inbox', folderFuzzy: true, ordering: 'date', limit: 50, offset: 0,
    });
    expect(res).toEqual({ rows: [], hasCondition: false });
    expect(fn).not.toHaveBeenCalled();
  });

  it('emits the pre-existing SQL shape and bind params for a from:+term all-folder query', async () => {
    const { fn, calls } = mockClient();
    const res = await searchLexical(fn, {
      parsed: {
        filters: [{ key: 'from', value: 'amazon', negate: false }],
        terms: [{ value: 'invoice', negate: false }],
      },
      accountIds: ['a1', 'a2'], folderScope: null, folderFuzzy: false, ordering: 'date', limit: 50, offset: 0,
    });
    expect(res.hasCondition).toBe(true);
    expect(res.rows).toEqual([{ id: 'x' }]);
    const { text, params } = calls[0];
    // Params: [accountIds, from-like, term-like, term-fts, limit, offset]
    expect(params).toEqual([['a1', 'a2'], '%amazon%', '%invoice%', 'invoice', 50, 0]);
    // Load-bearing SQL shape (byte-identical gate: the human-runnable old-vs-new diff).
    expect(text).toContain('WHERE m.account_id = ANY($1)');
    expect(text).toContain('AND m.is_deleted = false');
    expect(text).toContain('(m.from_email ILIKE $2 OR m.from_name ILIKE $2)');
    expect(text).toContain('NOT EXISTS'); // trash exclusion on all-folder search
    expect(text).toContain('ORDER BY m.date DESC');
    expect(text).toContain('LIMIT $5 OFFSET $6');
  });

  it('adds a cc_addresses predicate for the new cc: operator', async () => {
    const { fn, calls } = mockClient();
    await searchLexical(fn, {
      parsed: { filters: [{ key: 'cc', value: 'boss', negate: false }], terms: [] },
      accountIds: ['a1'], folderScope: 'INBOX', folderFuzzy: false, ordering: 'date', limit: 50, offset: 0,
    });
    expect(calls[0].text).toContain('m.cc_addresses::text ILIKE $2');
    expect(calls[0].params).toEqual([['a1'], '%boss%', 'INBOX', 50, 0]);
  });

});

describe('ranked lexical query (slice 02)', () => {
  function mockClient() {
    const calls = [];
    const fn = vi.fn(async (text, params) => { calls.push({ text, params }); return { rows: [] }; });
    return { fn, calls };
  }

  it('LEXICAL_RANK_SQL emits ts_rank_cd with the D,C,B,A weight array and normalization 32', () => {
    const expr = LEXICAL_RANK_SQL('m.search_fts', "plainto_tsquery('english', $7)");
    expect(expr).toBe("ts_rank_cd(ARRAY[0.1, 0.1, 0.4, 1.0]::real[], m.search_fts, plainto_tsquery('english', $7), 32)");
  });

  it('freeTextTermConditionRanked prefix-matches a single-word term against search_fts, falling back only when it IS NULL', () => {
    const cond = freeTextTermConditionRanked(3, 4, 'invoice');
    expect(cond).toContain("m.search_fts @@ to_tsquery('english', quote_literal($4) || ':*')");
    expect(cond).not.toContain("m.search_fts @@ plainto_tsquery");
    expect(cond).toContain('m.search_fts IS NULL AND');
    // The IS-NULL fallback branch is untouched legacy SQL (freeTextTermCondition):
    // still plainto_tsquery + ILIKE, since it only serves un-backfilled rows.
    expect(cond).toContain(`LEFT(coalesce(m.body_text,''), ${FTS_BODY_CHAR_CAP})`);
    expect(cond).toContain("m.search_vector @@ plainto_tsquery('english', $4)");
  });

  it('freeTextTermConditionRanked keeps non-prefix phrase matching for a quoted multi-word term', () => {
    const cond = freeTextTermConditionRanked(3, 4, 'weekly report');
    expect(cond).toContain("m.search_fts @@ plainto_tsquery('english', $4)");
    expect(cond).not.toContain("m.search_fts @@ to_tsquery");
  });

  it('prefix-matching passes the raw term through as an ordinary bind param — quoting/escaping happens in SQL via quote_literal, never in JS', async () => {
    const { fn, calls } = mockClient();
    const weird = `d'Angelo:*(evil)`;
    await searchLexical(fn, {
      parsed: { filters: [], terms: [{ value: weird, negate: false }] },
      accountIds: ['a1'], folderScope: 'INBOX', folderFuzzy: false, ordering: 'date', limit: 50, offset: 0,
    });
    const { text, params } = calls[0];
    // The term is bound VERBATIM (no JS-side escaping) — quote_literal() at
    // query time is what neutralizes '/:/* /()/etc. so it can't act as tsquery
    // syntax or break out of the quoted lexeme.
    expect(params).toContain(weird);
    expect(text).toContain("to_tsquery('english', quote_literal($3) || ':*')");
  });

  it('drops a punctuation-only term (msgvault hasFTSToken parity) instead of emitting an invalid tsquery', async () => {
    const { fn } = mockClient();
    const res = await searchLexical(fn, {
      parsed: { filters: [], terms: [{ value: '!!!', negate: false }] },
      accountIds: ['a1'], folderScope: 'INBOX', folderFuzzy: false, ordering: 'date', limit: 50, offset: 0,
    });
    // A punctuation-only term contributes no condition at all — same
    // treatment as an under-length term — so a bare "!!!" search never
    // dumps the whole folder and never reaches Postgres with a term that
    // would normalize to zero lexemes.
    expect(res).toEqual({ rows: [], hasCondition: false });
    expect(fn).not.toHaveBeenCalled();
  });

  it('drops a punctuation-only term while keeping a real term alongside it', async () => {
    const { fn, calls } = mockClient();
    await searchLexical(fn, {
      parsed: { filters: [], terms: [{ value: 'invoice', negate: false }, { value: '***', negate: false }] },
      accountIds: ['a1'], folderScope: 'INBOX', folderFuzzy: false, ordering: 'date', limit: 50, offset: 0,
    });
    // Only the real term's params were pushed: [accountIds, like, fts, folder, limit, offset].
    expect(calls[0].params).toEqual([['a1'], '%invoice%', 'invoice', 'INBOX', 50, 0]);
  });

  it('orders by ts_rank_cd then date/id for a relevance query, binding the rank args before LIMIT/OFFSET', async () => {
    const { fn, calls } = mockClient();
    await searchLexical(fn, {
      parsed: { filters: [], terms: [{ value: 'invoice', negate: false }, { value: 'urgent', negate: false }] },
      accountIds: ['a1'], folderScope: null, folderFuzzy: false, ordering: 'relevance', limit: 50, offset: 0,
    });
    const { text, params } = calls[0];
    // NULL-safe: ts_rank_cd(..., NULL::tsvector, ...) returns NULL, and Postgres
    // sorts NULLs FIRST in DESC order — without COALESCE, every un-backfilled
    // (search_fts IS NULL) row would outrank every properly ranked hit during
    // the backfill window. COALESCE(..., 0) keeps un-backfilled rows sorting
    // by date/id like today, below any real (non-negative) rank score.
    expect(text).toContain('ORDER BY COALESCE(ts_rank_cd');
    expect(text).toContain('32), 0) DESC, m.date DESC, m.id DESC');
    // Fix 5: rank reuses the SAME prefix-aware per-term tsquery as the MATCH
    // predicate (ftsTermQueryArg), one bind per term combined with && — NOT a
    // single plainto_tsquery over the joined string — so a prefix-only hit ranks
    // by ts_rank_cd instead of collapsing to COALESCE(0) date order.
    expect(text).toContain(
      "ts_rank_cd(ARRAY[0.1, 0.1, 0.4, 1.0]::real[], m.search_fts, to_tsquery('english', quote_literal($6) || ':*') && to_tsquery('english', quote_literal($7) || ':*'), 32)"
    );
    // Params: [accountIds, t1-like, t1-fts, t2-like, t2-fts, t1-rank, t2-rank, limit, offset]
    expect(params).toEqual([['a1'], '%invoice%', 'invoice', '%urgent%', 'urgent', 'invoice', 'urgent', 50, 0]);
  });

  it('ranks a prefix-only term with the SAME builder output as the MATCH predicate (Fix 5 — never rank 0)', async () => {
    const { fn, calls } = mockClient();
    await searchLexical(fn, {
      parsed: { filters: [], terms: [{ value: 'invo', negate: false }] },
      accountIds: ['a1'], folderScope: 'INBOX', folderFuzzy: false, ordering: 'relevance', limit: 50, offset: 0,
    });
    const { text, params } = calls[0];
    // The MATCH predicate prefix-matches via ftsTermQueryArg; the rank arg is the
    // SAME per-term construction (different bind ordinal only), so predicate and
    // rank can never diverge on prefix-vs-plainto.
    expect(text).toContain("m.search_fts @@ to_tsquery('english', quote_literal($3) || ':*')"); // predicate
    expect(text).toContain(
      "ts_rank_cd(ARRAY[0.1, 0.1, 0.4, 1.0]::real[], m.search_fts, to_tsquery('english', quote_literal($5) || ':*'), 32)" // rank
    );
    // Params: [accountIds, term-like, term-fts(predicate), folder, term-fts(rank), limit, offset]
    expect(params).toEqual([['a1'], '%invo%', 'invo', 'INBOX', 'invo', 50, 0]);
  });

  it('keeps non-prefix phrase matching in the rank for a quoted multi-word positive term (mirrors the predicate)', async () => {
    const { fn, calls } = mockClient();
    await searchLexical(fn, {
      parsed: { filters: [], terms: [{ value: 'weekly report', negate: false }] },
      accountIds: ['a1'], folderScope: 'INBOX', folderFuzzy: false, ordering: 'relevance', limit: 50, offset: 0,
    });
    const { text } = calls[0];
    // A phrase term ranks (and matches) via plainto_tsquery — no prefix ':*'.
    expect(text).toContain("ts_rank_cd(ARRAY[0.1, 0.1, 0.4, 1.0]::real[], m.search_fts, plainto_tsquery('english', $5), 32)");
    expect(text).not.toContain("quote_literal($5) || ':*'");
  });

  it('keeps date ordering (no ts_rank_cd) for a filter-only query', async () => {
    const { fn, calls } = mockClient();
    await searchLexical(fn, {
      parsed: { filters: [{ key: 'is', value: 'unread', negate: false }], terms: [] },
      accountIds: ['a1'], folderScope: 'INBOX', folderFuzzy: false, ordering: 'date', limit: 50, offset: 0,
    });
    expect(calls[0].text).toContain('ORDER BY m.date DESC');
    expect(calls[0].text).not.toContain('ts_rank_cd');
  });
});

describe('stopword-safe free-text predicates (Wave D Fix 1)', () => {
  // Root cause (verified against pgvector/pg16, 2026-07-17):
  //   to_tsquery('english', quote_literal('for') || ':*') normalizes to an
  //   EMPTY tsquery (numnode = 0), and `tsvector @@ <empty>` is FALSE for
  //   every row — so once rows were backfilled onto search_fts, one english
  //   stopword in an AND'd term chain ("waiting for invoice") nuked ALL
  //   results. The guard makes such a term vacuously TRUE instead.
  function mockClient() {
    const calls = [];
    const fn = vi.fn(async (text, params) => { calls.push({ text, params }); return { rows: [] }; });
    return { fn, calls };
  }

  it('stopwordSafeCondition wraps a clause with a numnode()=0 escape on the SAME bind as the match', () => {
    expect(stopwordSafeCondition(4, 'invoice', 'X')).toBe(
      "(numnode(to_tsquery('english', quote_literal($4) || ':*')) = 0 OR X)"
    );
    // Phrase terms probe emptiness through the SAME plainto construction the
    // match uses ("the on" normalizes empty exactly like a stopword word).
    expect(stopwordSafeCondition(4, 'weekly report', 'X')).toBe(
      "(numnode(plainto_tsquery('english', $4)) = 0 OR X)"
    );
  });

  it('wraps every positive free-text term condition, binding NO extra params', async () => {
    const { fn, calls } = mockClient();
    await searchLexical(fn, {
      parsed: { filters: [], terms: [
        { value: 'waiting', negate: false },
        { value: 'for', negate: false },
        { value: 'invoice', negate: false },
      ] },
      accountIds: ['a1'], folderScope: 'INBOX', folderFuzzy: false, ordering: 'date', limit: 50, offset: 0,
    });
    const { text, params } = calls[0];
    // One guard per term, reusing that term's fts bind ordinal ($3, $5, $7).
    for (const ftsIdx of [3, 5, 7]) {
      expect(text).toContain(`(numnode(to_tsquery('english', quote_literal($${ftsIdx}) || ':*')) = 0 OR (`);
    }
    // Guard adds no binds: [accountIds, like1, fts1, like2, fts2, like3, fts3, folder, limit, offset]
    expect(params).toEqual([['a1'], '%waiting%', 'waiting', '%for%', 'for', '%invoice%', 'invoice', 'INBOX', 50, 0]);
  });

  it('applies the guard OUTSIDE the negation so a negated stopword also contributes nothing', async () => {
    const { fn, calls } = mockClient();
    await searchLexical(fn, {
      parsed: { filters: [], terms: [{ value: 'the', negate: true }] },
      accountIds: ['a1'], folderScope: 'INBOX', folderFuzzy: false, ordering: 'date', limit: 50, offset: 0,
    });
    const { text } = calls[0];
    // (empty OR NOT COALESCE(match)) — vacuously TRUE for a stopword in BOTH
    // polarities; a plain NOT-wrap of the guarded condition would instead be
    // FALSE and exclude everything.
    expect(text).toContain("(numnode(to_tsquery('english', quote_literal($3) || ':*')) = 0 OR NOT COALESCE(");
  });

  it('freeTextTermClause is the one owner searchLexical and the staging path share', () => {
    const params = [];
    let p = 2;
    const bind = (v) => { params.push(v); return `$${p++}`; };
    const clause = freeTextTermClause('invoice', false, bind);
    expect(params).toEqual(['%invoice%', 'invoice']);
    expect(clause.startsWith("(numnode(to_tsquery('english', quote_literal($3) || ':*')) = 0 OR (")).toBe(true);
    expect(clause).toContain("m.search_fts @@ to_tsquery('english', quote_literal($3) || ':*')");
    expect(clause).toContain('m.search_fts IS NULL AND');
  });

  it('negatedFreeTextClause carries the guard outside the NOT (fused NOT-conditions)', () => {
    const params = [];
    let p = 2;
    const bind = (v) => { params.push(v); return `$${p++}`; };
    const clause = negatedFreeTextClause('the', bind);
    expect(clause.startsWith("(numnode(to_tsquery('english', quote_literal($3) || ':*')) = 0 OR NOT COALESCE(")).toBe(true);
  });
});

describe('buildOperatorClauses (Phase 4 Task 2a — extracted from searchLexical)', () => {
  function bindHarness(start = 2) {
    const params = [];
    let p = start;
    const bind = (v) => { params.push(v); return `$${p++}`; };
    return { bind, params };
  }

  it('builds a from: predicate reusing one bind for both ILIKE arms', () => {
    const { bind, params } = bindHarness();
    const conds = buildOperatorClauses([{ key: 'from', value: 'amazon', negate: false }], bind);
    expect(conds).toEqual(['(m.from_email ILIKE $2 OR m.from_name ILIKE $2)']);
    expect(params).toEqual(['%amazon%']);
  });

  it('builds a cc: predicate', () => {
    const { bind, params } = bindHarness();
    const conds = buildOperatorClauses([{ key: 'cc', value: 'boss', negate: false }], bind);
    expect(conds).toEqual(['m.cc_addresses::text ILIKE $2']);
    expect(params).toEqual(['%boss%']);
  });

  it('negates a structured operator via negateCond', () => {
    const { bind } = bindHarness();
    const conds = buildOperatorClauses([{ key: 'subject', value: 'invoice', negate: true }], bind);
    expect(conds).toEqual(['NOT COALESCE((m.subject ILIKE $2), false)']);
  });

  it('skips in: (scope control, not a row condition) and malformed after/before', () => {
    const { bind, params } = bindHarness();
    const conds = buildOperatorClauses([
      { key: 'in', value: 'inbox', negate: false },
      { key: 'after', value: 'not-a-date', negate: false },
    ], bind);
    expect(conds).toEqual([]);
    expect(params).toEqual([]);
  });

  it('does not bind free-text terms or folder scope (structured operators only)', () => {
    const { bind } = bindHarness();
    const conds = buildOperatorClauses([{ key: 'is', value: 'unread', negate: false }], bind);
    expect(conds).toEqual(['m.is_read = false']);
  });
});

describe('buildFolderScopeClauses (folder scope — shared by lexical + fused)', () => {
  function bindHarness(start = 2) {
    const params = [];
    let p = start;
    const bind = (v) => { params.push(v); return `$${p++}`; };
    return { bind, params };
  }

  it('fuzzy in:<name> matches the bare name or any .../<name> path', () => {
    const { bind, params } = bindHarness();
    const conds = buildFolderScopeClauses('sent', true, bind);
    expect(conds).toEqual(['(m.folder ILIKE $2 OR m.folder ILIKE $3)']);
    expect(params).toEqual(['sent', '%/sent']);
  });

  it('an exact folderScope (REST ?folder=) matches the full path', () => {
    const { bind, params } = bindHarness();
    const conds = buildFolderScopeClauses('INBOX', false, bind);
    expect(conds).toEqual(['m.folder = $2']);
    expect(params).toEqual(['INBOX']);
  });

  it('a null folderScope excludes trash-like folders (default search scope), binding nothing', () => {
    const { bind, params } = bindHarness();
    const conds = buildFolderScopeClauses(null, false, bind);
    expect(conds).toHaveLength(1);
    expect(conds[0]).toContain('NOT EXISTS');
    expect(conds[0]).toContain('%trash%');
    expect(params).toEqual([]);
  });
});

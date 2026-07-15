import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn((v) => v) }));

import { query } from './db.js';
import {
  buildGistPrompt,
  sanitizeGist,
  selectGistCandidates,
  queueGistGeneration,
} from './gtdGist.js';

describe('buildGistPrompt', () => {
  it('includes from, subject, and a whitespace-collapsed body', () => {
    const prompt = buildGistPrompt({ subject: 'Reports', from: 'Alice', content: 'pulling   the\n\nDeel  reports friday' });
    expect(prompt).toContain('From: Alice');
    expect(prompt).toContain('Subject: Reports');
    expect(prompt).toContain('Body: pulling the Deel reports friday');
    expect(prompt).toMatch(/ONE line of at most 120 characters/);
  });

  it('caps the body length and tolerates missing fields', () => {
    const prompt = buildGistPrompt({ content: 'x'.repeat(5000) });
    expect(prompt).toContain('From: (unknown)');
    // 1000-char body cap: the prompt shouldn't carry the whole 5000-char blob.
    expect(prompt.length).toBeLessThan(1400);
  });
});

describe('sanitizeGist', () => {
  it('takes the first non-empty line and trims', () => {
    expect(sanitizeGist('\n  pulling the Deel reports friday  \nextra')).toBe('pulling the Deel reports friday');
  });

  it('strips wrapping quotes and emoji', () => {
    expect(sanitizeGist('"waiting on their reply 🎉"')).toBe('waiting on their reply');
    expect(sanitizeGist('“sending the invoice ❤️ next week”')).toBe('sending the invoice next week');
  });

  it('collapses whitespace and hard-caps at 120 chars', () => {
    const long = 'a '.repeat(200);
    const out = sanitizeGist(long);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out).not.toMatch(/\s{2,}/);
  });

  it('returns null for empty or non-string input', () => {
    expect(sanitizeGist('')).toBeNull();
    expect(sanitizeGist('   ')).toBeNull();
    expect(sanitizeGist(null)).toBeNull();
    expect(sanitizeGist(42)).toBeNull();
  });
});

describe('selectGistCandidates', () => {
  const head = (over) => ({ id: over.id, account_id: over.account_id ?? 'a1', gist: over.gist ?? null });

  it('returns watch + delegated heads that lack a gist', () => {
    const sections = {
      todo: { threads: [head({ id: 't1' })] },       // todo never carries a gist
      watch: { threads: [head({ id: 'w1' }), head({ id: 'w2', gist: 'cached' })] },
      delegated: { threads: [head({ id: 'd1' })] },
      someday: { threads: [head({ id: 's1' })] },
      reference: { threads: [head({ id: 'r1' })] },
    };
    const ids = selectGistCandidates(sections).map(c => c.id);
    expect(ids).toEqual(['w1', 'd1']); // w2 already cached; todo/someday/reference excluded
  });

  it('dedupes by id and tolerates missing sections', () => {
    const sections = { watch: { threads: [head({ id: 'x' }), head({ id: 'x' })] } };
    expect(selectGistCandidates(sections).map(c => c.id)).toEqual(['x']);
    expect(selectGistCandidates({})).toEqual([]);
    expect(selectGistCandidates(null)).toEqual([]);
  });
});

describe('queueGistGeneration — provider gating', () => {
  beforeEach(() => { query.mockReset(); });

  const oneWaiting = { watch: { threads: [{ id: 'w1', account_id: 'a1', gist: null }] } };

  it('does no work at all when there are no candidates', async () => {
    await queueGistGeneration({ sections: { watch: { threads: [] } }, userId: 'u1', broadcast: vi.fn() });
    expect(query).not.toHaveBeenCalled();
  });

  it('reads the provider config once and issues zero generation queries when no AI is configured', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // ai_config missing
    const broadcast = vi.fn();

    await queueGistGeneration({ sections: oneWaiting, userId: 'u1', broadcast });

    // Only the provider-config gate ran; no body fetch, no UPDATE, no broadcast.
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(/ai_config/);
    const wroteGist = query.mock.calls.some(c => /UPDATE messages SET gtd_gist/i.test(c[0]));
    expect(wroteGist).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('does not run generation when the provider is present but summarize is disabled', async () => {
    query.mockResolvedValueOnce({ rows: [{ value: JSON.stringify({ enabled: true, baseUrl: 'http://ai', model: 'm', features: { summarize: false } }) }] });
    await queueGistGeneration({ sections: oneWaiting, userId: 'u1', broadcast: vi.fn() });
    expect(query).toHaveBeenCalledTimes(1); // gate only
  });
});

describe('queueGistGeneration — write path', () => {
  const providerCfg = { enabled: true, baseUrl: 'http://ai', model: 'm' };
  const isConfigSql = (sql) => /system_settings/.test(sql);
  const isBodySelect = (sql) => /FROM messages/i.test(sql) && /SELECT id, subject/i.test(sql);
  const isGistUpdate = (sql) => /UPDATE messages SET gtd_gist/i.test(sql);

  // Route query() by SQL rather than by call order: GIST_CONCURRENCY runs UPDATEs from
  // the pool concurrently, so their relative ordering isn't deterministic. The body
  // SELECT echoes one row per requested id so the pool has real work to do.
  function mockDb({ config = providerCfg, updateRowCount = 1 } = {}) {
    query.mockImplementation((sql, params) => {
      if (isConfigSql(sql)) {
        return Promise.resolve({ rows: config == null ? [] : [{ value: JSON.stringify(config) }] });
      }
      if (isBodySelect(sql)) {
        const ids = params[0];
        return Promise.resolve({
          rows: ids.map((id) => ({ id, subject: `S ${id}`, from_name: 'Alice', from_email: 'a@x', content: `body ${id}` })),
        });
      }
      if (isGistUpdate(sql)) return Promise.resolve({ rowCount: updateRowCount });
      return Promise.resolve({ rows: [] });
    });
  }

  const waitingHeads = (ids, accountId = 'a1') => ({
    watch: { threads: ids.map((id) => ({ id, account_id: accountId, gist: null })) },
  });

  beforeEach(() => {
    query.mockReset();
    // Model reply arrives wrapped in quotes and carrying an emoji so the write-path
    // assertion also proves we persist the sanitised gist, not the raw provider output.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '"waiting on their reply 🎉"' } }] }),
    }));
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('writes the sanitised gist keyed on id + gtd_gist IS NULL and broadcasts once (wrote > 0)', async () => {
    mockDb();
    const broadcast = vi.fn();

    await queueGistGeneration({ sections: waitingHeads(['w1']), userId: 'u1', broadcast });

    expect(fetch).toHaveBeenCalledTimes(1);

    const selectCall = query.mock.calls.find((c) => isBodySelect(c[0]));
    // FIX 2: the body SELECT is scoped to the account, not just the id list.
    expect(selectCall[0]).toMatch(/account_id = \$2/);
    expect(selectCall[1]).toEqual([['w1'], 'a1']);

    const updateCall = query.mock.calls.find((c) => isGistUpdate(c[0]));
    expect(updateCall[0]).toMatch(/gtd_gist IS NULL/); // lost-race re-check preserved
    expect(updateCall[1]).toEqual(['waiting on their reply', 'w1']);

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: 'a1' }, 'u1');
  });

  it('does not broadcast when the UPDATE writes nothing (wrote === 0 — a newer head won the race)', async () => {
    mockDb({ updateRowCount: 0 });
    const broadcast = vi.fn();

    await queueGistGeneration({ sections: waitingHeads(['w1']), userId: 'u1', broadcast });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some((c) => isGistUpdate(c[0]))).toBe(true); // UPDATE still attempted
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('caps generation per account at MAX_GISTS_PER_ACCOUNT (20), deferring the remainder', async () => {
    mockDb();
    const broadcast = vi.fn();
    const ids = Array.from({ length: 25 }, (_, i) => `w${i}`);

    await queueGistGeneration({ sections: waitingHeads(ids), userId: 'u1', broadcast });

    const selectCall = query.mock.calls.find((c) => isBodySelect(c[0]));
    expect(selectCall[1][0]).toHaveLength(20); // only the cap's worth reaches the DB
    expect(fetch).toHaveBeenCalledTimes(20); // and only that many are generated
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('dedupes an overlapping queue for the same head so it is generated only once (FIX 1)', async () => {
    // Hold the first call inside loadGistProvider so a second call overlaps it while the
    // first sits between reserving its ids and generating — the exact TOCTOU window.
    let releaseConfig;
    const configGate = new Promise((resolve) => { releaseConfig = resolve; });
    query.mockImplementation((sql, params) => {
      if (isConfigSql(sql)) return configGate.then(() => ({ rows: [{ value: JSON.stringify(providerCfg) }] }));
      if (isBodySelect(sql)) {
        const ids = params[0];
        return Promise.resolve({ rows: ids.map((id) => ({ id, subject: 'S', from_name: 'A', from_email: 'a@x', content: 'b' })) });
      }
      if (isGistUpdate(sql)) return Promise.resolve({ rowCount: 1 });
      return Promise.resolve({ rows: [] });
    });
    const broadcast = vi.fn();
    const sections = waitingHeads(['w1']);

    const first = queueGistGeneration({ sections, userId: 'u1', broadcast });
    // Overlaps while `first` is still awaiting its provider load. With the id reserved
    // synchronously up front, this call finds no candidates and short-circuits before
    // it ever reaches the provider gate; without the fix it too would pass the filter,
    // load the provider, and regenerate w1 (2 config reads, 2 selects, 2 fetches).
    const second = queueGistGeneration({ sections, userId: 'u1', broadcast });

    releaseConfig();
    await Promise.all([first, second]);

    expect(query.mock.calls.filter((c) => isConfigSql(c[0]))).toHaveLength(1); // second never reached the gate
    expect(query.mock.calls.filter((c) => isBodySelect(c[0]))).toHaveLength(1);
    expect(query.mock.calls.filter((c) => isGistUpdate(c[0]))).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });
});

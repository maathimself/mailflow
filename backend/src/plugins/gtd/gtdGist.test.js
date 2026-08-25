import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../../services/aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));

import { query } from '../../services/db.js';
import { completeText, getAiStatus } from '../../services/aiProvider.js';
import {
  selectGistCandidates,
  queueGistGeneration,
} from './gtdGist.js';

// buildGistPrompt/sanitizeGist moved to the generic `summarize` capability — see
// summarize.test.js. This file now covers only GTD's orchestration: candidate selection,
// provider gating, and the bounded write/broadcast path.

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
  beforeEach(() => {
    query.mockReset();
    getAiStatus.mockReset();
    completeText.mockReset();
  });

  const oneWaiting = { watch: { threads: [{ id: 'w1', account_id: 'a1', gist: null }] } };

  it('does no work at all when there are no candidates', async () => {
    await queueGistGeneration({ sections: { watch: { threads: [] } }, userId: 'u1', broadcast: vi.fn() });
    expect(getAiStatus).not.toHaveBeenCalled();
    expect(completeText).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('issues zero generation queries when the selected AI provider is unavailable', async () => {
    getAiStatus.mockResolvedValue({ enabled: false, features: { summarize: true } });
    const broadcast = vi.fn();

    await queueGistGeneration({ sections: oneWaiting, userId: 'u1', broadcast });

    expect(getAiStatus).toHaveBeenCalledTimes(1);
    expect(completeText).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('does not run generation when the provider is present but summarize is disabled', async () => {
    getAiStatus.mockResolvedValue({ enabled: true, features: { summarize: false } });
    await queueGistGeneration({ sections: oneWaiting, userId: 'u1', broadcast: vi.fn() });
    expect(getAiStatus).toHaveBeenCalledTimes(1);
    expect(completeText).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('treats provider status failures as unavailable', async () => {
    getAiStatus.mockRejectedValue(new Error('status unavailable'));
    await expect(queueGistGeneration({ sections: oneWaiting, userId: 'u1', broadcast: vi.fn() }))
      .resolves.toBeUndefined();
    expect(completeText).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('queueGistGeneration — write path', () => {
  const isBodySelect = (sql) => /SELECT m\.id, m\.uid, m\.folder/i.test(sql);
  const isSnapshotValidation = (sql) => /SELECT 1[\s\S]*FROM messages m/i.test(sql);
  // The gist is now stored as a plugin annotation on the message (jsonb_set into plugin_annotations).
  const isGistUpdate = (sql) => /UPDATE messages(?:\s+m)?\s+SET plugin_annotations/i.test(sql);

  // Route query() by SQL rather than by call order: GIST_CONCURRENCY runs UPDATEs from
  // the pool concurrently, so their relative ordering isn't deterministic. The body
  // SELECT echoes one row per requested id so the pool has real work to do.
  function mockDb({ updateRowCount = 1, snapshotMatches = null } = {}) {
    const pendingSnapshotMatches = snapshotMatches ? [...snapshotMatches] : null;
    query.mockImplementation((sql, params) => {
      if (isBodySelect(sql)) {
        const ids = params[0];
        return Promise.resolve({
          rows: ids.map((id) => ({
            id, uid: '11', folder: 'Watch', subject: `S ${id}`,
            from_name: 'Alice', from_email: 'a@x', content: `body ${id}`,
            read_revision: '2', star_revision: '3',
            folder_uid_validity: '44', folder_observation_generation: '5',
          })),
        });
      }
      if (isSnapshotValidation(sql)) {
        const matches = pendingSnapshotMatches ? pendingSnapshotMatches.shift() : true;
        return Promise.resolve({ rows: matches ? [{ matches: 1 }] : [] });
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
    getAiStatus.mockReset();
    completeText.mockReset();
    getAiStatus.mockResolvedValue({ enabled: true, features: { summarize: true } });
    // Model reply arrives wrapped in quotes and carrying an emoji so the write-path
    // assertion also proves we persist the sanitised gist, not the raw provider output.
    completeText.mockResolvedValue('"waiting on their reply 🎉"');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('writes the sanitised gist into the message\'s gtd annotation and broadcasts once (wrote > 0)', async () => {
    mockDb();
    const broadcast = vi.fn();

    await queueGistGeneration({ sections: waitingHeads(['w1']), userId: 'u1', broadcast });

    expect(completeText).toHaveBeenCalledWith([
      { role: 'user', content: expect.stringContaining('Subject: S w1') },
    ], { maxTokens: 120 });
    expect(fetch).not.toHaveBeenCalled();

    const selectCall = query.mock.calls.find((c) => isBodySelect(c[0]));
    // The body read (getMessageFields) is scoped to the account, not just the id list.
    expect(selectCall[0]).toMatch(/account_id = \$2/);
    expect(selectCall[0]).toMatch(/JOIN folders f/);
    expect(selectCall[0]).toMatch(/m\.metadata_complete = true/);
    expect(selectCall[0]).toMatch(/f\.is_present = true/);
    expect(selectCall[0]).toMatch(/f\.uid_validity IS NOT NULL/);
    expect(selectCall[1]).toEqual([['w1'], 'a1']);

    const validationCalls = query.mock.calls.filter((c) => isSnapshotValidation(c[0]));
    expect(validationCalls).toHaveLength(2);
    expect(validationCalls[0][1]).toEqual([
      'a1', 'w1', '11', 'Watch', '2', '3', '44', '5',
      'S w1', 'Alice', 'a@x', 'body w1',
    ]);

    // Persists the sanitised gist under the message's GTD annotation namespace (account-scoped).
    const updateCall = query.mock.calls.find((c) => isGistUpdate(c[0]));
    expect(updateCall[0]).toMatch(/FROM folders f/);
    expect(updateCall[0]).toMatch(/m\.read_revision = \$7/);
    expect(updateCall[0]).toMatch(/f\.observation_generation = \$10/);
    expect(updateCall[1]).toEqual([
      'a1', 'w1', 'gtd', JSON.stringify({ gist: 'waiting on their reply' }),
      '11', 'Watch', '2', '3', '44', '5', 'S w1', 'Alice', 'a@x', 'body w1',
    ]);

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: 'a1' }, 'u1');
  });

  it('does not send message text to AI when the live snapshot is superseded before generation', async () => {
    mockDb({ snapshotMatches: [false] });

    await queueGistGeneration({ sections: waitingHeads(['w1']), userId: 'u1', broadcast: vi.fn() });

    expect(completeText).not.toHaveBeenCalled();
    expect(query.mock.calls.some((c) => isGistUpdate(c[0]))).toBe(false);
  });

  it('does not annotate or broadcast when the snapshot is superseded while AI is running', async () => {
    mockDb({ snapshotMatches: [true, false] });
    const broadcast = vi.fn();

    await queueGistGeneration({ sections: waitingHeads(['w1']), userId: 'u1', broadcast });

    expect(completeText).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some((c) => isGistUpdate(c[0]))).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('does not broadcast when the UPDATE writes nothing (wrote === 0 — a newer head won the race)', async () => {
    mockDb({ updateRowCount: 0 });
    const broadcast = vi.fn();

    await queueGistGeneration({ sections: waitingHeads(['w1']), userId: 'u1', broadcast });

    expect(completeText).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
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
    expect(completeText).toHaveBeenCalledTimes(20); // and only that many are generated
    expect(fetch).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('dedupes an overlapping queue for the same head so it is generated only once (FIX 1)', async () => {
    // Hold the first call inside the provider-status gate so a second call overlaps it while the
    // first sits between reserving its ids and generating — the exact TOCTOU window.
    let releaseConfig;
    const configGate = new Promise((resolve) => { releaseConfig = resolve; });
    getAiStatus.mockImplementation(() => configGate.then(() => ({ enabled: true, features: { summarize: true } })));
    query.mockImplementation((sql, params) => {
      if (isBodySelect(sql)) {
        const ids = params[0];
        return Promise.resolve({ rows: ids.map((id) => ({
          id, uid: '11', folder: 'Watch', subject: 'S', from_name: 'A', from_email: 'a@x', content: 'b',
          read_revision: '2', star_revision: '3',
          folder_uid_validity: '44', folder_observation_generation: '5',
        })) });
      }
      if (isSnapshotValidation(sql)) return Promise.resolve({ rows: [{ matches: 1 }] });
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

    expect(getAiStatus).toHaveBeenCalledTimes(1); // second never reached the gate
    expect(query.mock.calls.filter((c) => isBodySelect(c[0]))).toHaveLength(1);
    expect(query.mock.calls.filter((c) => isGistUpdate(c[0]))).toHaveLength(1);
    expect(completeText).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledTimes(1);
  });
});

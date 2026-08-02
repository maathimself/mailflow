import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression for the live MCP bug: `semantic_search_messages` returned 0 because
// hybrid/vector seam hits carry `message_id` (fusedSearch DISPLAY_COLS), not `id`,
// so the handler's `byId.get(m.id)` hydration mapped every hit to null.
//
// Unlike searchTools.test.js (which mocks the searchService seam directly), this
// test drives the REAL seam and mocks only the DEEPER dependency (hybridSearch)
// with the REAL fused-row field inventory the running container exposed
// (message_id/uid/folder/…/rrf_score/best_char_*). That exercises the actual
// `id`-alias fix in searchService plus the handler's hydration + excerpt + explain
// assembly end-to-end: it fails (returned:0) without the seam fix and passes with it.
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn(), pool: {} }));
vi.mock('../services/embeddings/hybrid.js', () => ({
  hybridSearch: vi.fn(),
  isLexicalFallback: () => false,
  MissingFreeTextError: class MissingFreeTextError extends Error {},
  VectorUnavailableError: class VectorUnavailableError extends Error {
    constructor(reason) { super(reason); this.name = 'VectorUnavailableError'; this.reason = reason; }
  },
  resolveActiveGeneration: vi.fn(),
}));
vi.mock('../services/embeddings/chunkmatch.js', () => ({ matchFromChunk: vi.fn(), matchesInMessage: vi.fn() }));
vi.mock('./engineAdapter.js', () => ({ getMessageSummariesByIDs: vi.fn(), resolveAccountScope: vi.fn() }));

import { hybridSearch } from '../services/embeddings/hybrid.js';
import { matchFromChunk } from '../services/embeddings/chunkmatch.js';
import { getMessageSummariesByIDs, resolveAccountScope } from './engineAdapter.js';
import { handleSemanticSearchMessages } from './searchTools.js';

const scope = { userId: 'u1', accountIds: ['acc-1'] };
const payload = (r) => JSON.parse(r.content[0].text);

// The exact key inventory the deployed container returned for a hybrid/vector hit —
// keyed on message_id, with NO `id` (that is the bug the seam fix repairs).
function realFusedHit(overrides = {}) {
  return {
    message_id: 'uuid-1', uid: 42, folder: 'INBOX',
    subject: 'Run failed: CD deploy', from_name: 'GitHub', from_email: 'notifications@github.com',
    date: new Date('2026-07-15T00:00:00Z'), snippet: 'deployment failing', is_read: false,
    is_starred: false, has_attachments: false, account_id: 'acc-1',
    account_name: 'Work', account_email: 'me@work.com', account_color: '#fff',
    rrf_score: 0.033, bm25_score: 1.2, vector_score: 0.88, subject_boosted: false,
    best_chunk_index: 0, best_char_start: 5, best_char_end: 40,
    ...overrides,
  };
}

beforeEach(() => {
  hybridSearch.mockReset(); matchFromChunk.mockReset();
  getMessageSummariesByIDs.mockReset(); resolveAccountScope.mockReset();
  resolveAccountScope.mockImplementation(async (account, ids) => ({ accountIds: ids }));
  // Hydration echoes each requested id back as a minimal summary.
  getMessageSummariesByIDs.mockImplementation(async (ids) =>
    ids.map((id) => ({ id, subject: 'Run failed: CD deploy', from_email: 'notifications@github.com' })));
});

describe('semantic_search_messages end-to-end over the real seam (message_id → id alias)', () => {
  for (const mode of ['hybrid', 'vector']) {
    it(`mode=${mode}: hydrates real message_id-keyed seam hits into data (was returned:0)`, async () => {
      hybridSearch.mockResolvedValue({
        hits: [realFusedHit()],
        poolSaturated: false,
        generation: { id: 3, model: 'text-embedding-3-small', dimension: 1536, fingerprint: 'fp', state: 'active' },
      });
      matchFromChunk.mockResolvedValue({ char_offset: 5, snippet: 'deploy', score: 0.88 });

      const r = await handleSemanticSearchMessages({ query: 'server deployment failing', mode, explain: true }, scope);
      const body = payload(r);

      expect(r.isError).toBeFalsy();
      expect(body.returned).toBe(1);                    // the bug returned 0
      expect(body.mode).toBe(mode);
      expect(body.data[0].id).toBe('uuid-1');           // hydrated via the aliased id
      expect(body.data[0].subject).toBe('Run failed: CD deploy');
      // explain surfaces the real per-signal fields with Go omitempty parity
      // (msgvault handlers.go:563-572): rrf only fuses in hybrid, and a false
      // subject_boosted is omitted from the wire.
      expect(body.data[0].score).toEqual(
        mode === 'hybrid' ? { rrf: 0.033, bm25: 1.2, vector: 0.88 } : { bm25: 1.2, vector: 0.88 },
      );
      // matches assembled from best_chunk, keyed on the aliased id
      expect(body.data[0].matches).toEqual([{ char_offset: 5, snippet: 'deploy', score: 0.88 }]);
      expect(getMessageSummariesByIDs).toHaveBeenCalledWith(['uuid-1'], ['acc-1']);
      expect(matchFromChunk).toHaveBeenCalledWith(
        'uuid-1', { chunk_index: 0, char_start: 5, char_end: 40, score: 0.88 }, { accountIds: ['acc-1'] });
    });
  }
});

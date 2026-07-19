import { describe, it, expect, vi, beforeEach } from 'vitest';

// Real module shapes (verified against source, not the plan's Consumes sketch):
//   preprocess(subject, body, maxChars, cfg) -> { text, truncated }
//   chunkText(text, maxRunes, overlap, maxSpans) -> { spans: [{text, charStart, charEnd}] }
//   client.js exports the EmbeddingClient class (no bare `embed`) — mirror hybrid.js:
//     new EmbeddingClient(cfg).embed([...]) -> number[][]
//   resolveEmbedConfig() is async; generationFingerprint(cfg) needs the full config.
const { mockEmbed } = vi.hoisted(() => ({ mockEmbed: vi.fn() }));

vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('./hybrid.js', () => ({ resolveActiveGenerationFromConfig: vi.fn() }));
vi.mock('./client.js', () => ({ EmbeddingClient: class { embed(...a) { return mockEmbed(...a); } } }));
vi.mock('./chunk.js', async (importOriginal) => ({ ...(await importOriginal()), chunkText: vi.fn() }));
vi.mock('./preprocess.js', () => ({ preprocess: vi.fn() }));
vi.mock('./config.js', () => ({
  generationFingerprint: vi.fn(() => 'fp'),
  resolveEmbedConfig: vi.fn(async () => ({
    enabled: true, endpoint: 'http://x', apiKey: null, model: 'm', dimension: 2,
    maxInputChars: 100, preprocess: {},
  })),
}));

import { query } from '../db.js';
import { resolveActiveGenerationFromConfig } from './hybrid.js';
import { chunkText } from './chunk.js';
import { preprocess } from './preprocess.js';
import { resolveEmbedConfig } from './config.js';
import { matchesInMessage, matchFromChunk } from './chunkmatch.js';

class VectorUnavailableError extends Error {
  constructor(r) { super(r); this.name = 'VectorUnavailableError'; this.reason = r; }
}

const cfg = {
  enabled: true, endpoint: 'http://x', apiKey: null, model: 'm', dimension: 2,
  maxInputChars: 100, preprocess: {},
};

beforeEach(() => {
  query.mockReset();
  resolveActiveGenerationFromConfig.mockReset();
  chunkText.mockReset();
  preprocess.mockReset();
  mockEmbed.mockReset();
  resolveEmbedConfig.mockReset();
  resolveEmbedConfig.mockResolvedValue(cfg);
  // matchesInMessage gets its cfg + generation from the one vector-availability gate.
  resolveActiveGenerationFromConfig.mockResolvedValue({ cfg, generation: { id: 1 } });
});

describe('matchesInMessage', () => {
  it('throws vector_not_enabled when embeddings are disabled', async () => {
    resolveActiveGenerationFromConfig.mockRejectedValueOnce(new VectorUnavailableError('vector_not_enabled'));
    await expect(matchesInMessage('m1', 'hi', 0, { accountIds: ['a'] }))
      .rejects.toHaveProperty('reason', 'vector_not_enabled');
  });

  it('propagates VectorUnavailableError on stock Postgres', async () => {
    resolveActiveGenerationFromConfig.mockRejectedValue(new VectorUnavailableError('no_active_generation'));
    await expect(matchesInMessage('m1', 'hi', 0, { accountIds: ['a'] }))
      .rejects.toHaveProperty('reason', 'no_active_generation');
  });

  it('scores body chunks, returns byte char_offset for a unique body chunk, filters by minScore', async () => {
    const subject = 'Trip';
    const body = 'café — the flight itinerary is attached and confirmed';
    query.mockResolvedValueOnce({ rows: [{ subject, body_text: body, body_html: '' }] });
    // preprocessed = "Subject: Trip\n\n" + body; prefix rune count decides subject vs body.
    preprocess.mockReturnValue({ text: 'Subject: Trip\n\n' + body });
    // one subject chunk, one body chunk that appears verbatim & uniquely in the raw body.
    chunkText.mockReturnValue({ spans: [
      { text: 'Subject: Trip', charStart: 0, charEnd: 13 },
      { text: 'the flight itinerary is attached', charStart: 15, charEnd: 47 },
    ] });
    // embed([query, chunk0, chunk1]) -> query aligns with chunk1 (score 1), chunk0 score 0.
    mockEmbed.mockResolvedValue([[1, 0], [0, 1], [1, 0]]);
    const out = await matchesInMessage('m1', 'flight itinerary', 0.5, { accountIds: ['a'] });
    expect(out).toHaveLength(1); // chunk0 filtered by minScore
    const byteOffset = Buffer.from(body, 'utf8').indexOf(Buffer.from('the flight itinerary is attached', 'utf8'));
    expect(out[0].char_offset).toBe(byteOffset); // BYTE offset into raw body
    expect(out[0].line).toBe(1);
    expect(out[0].score).toBeCloseTo(1);
    expect(out[0].snippet).toContain('flight itinerary');
    // message load was scoped to accountIds
    expect(query.mock.calls[0][1]).toEqual(['m1', ['a']]);
    // query embedded first, then each chunk text
    expect(mockEmbed).toHaveBeenCalledWith(['flight itinerary', 'Subject: Trip', 'the flight itinerary is attached']);
  });

  it('returns [] when the message is not in scope', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await matchesInMessage('m1', 'x', 0, { accountIds: ['a'] })).toEqual([]);
  });

  it('slices embed calls by cfg.batchSize and keeps query/chunk alignment across slices', async () => {
    resolveActiveGenerationFromConfig.mockResolvedValue({ cfg: { ...cfg, batchSize: 2 }, generation: { id: 1 } });
    query.mockResolvedValueOnce({ rows: [{ subject: '', body_text: 'b', body_html: '' }] });
    preprocess.mockReturnValue({ text: 'b' });
    chunkText.mockReturnValue({ spans: [
      { text: 'c0', charStart: 0, charEnd: 2 },
      { text: 'c1', charStart: 2, charEnd: 4 },
      { text: 'c2', charStart: 4, charEnd: 6 },
    ] });
    // 4 inputs (query + 3 chunks) with batchSize 2 → two calls of 2.
    mockEmbed
      .mockResolvedValueOnce([[1, 0], [0, 1]])   // [query, c0]
      .mockResolvedValueOnce([[1, 0], [0, 1]]);  // [c1, c2] — c1 aligns with the query
    const out = await matchesInMessage('m1', 'q', 0.5, { accountIds: ['a'] });
    expect(mockEmbed.mock.calls.map((c) => c[0])).toEqual([['q', 'c0'], ['c1', 'c2']]);
    expect(out).toHaveLength(1);
    expect(out[0].snippet).toBe('c1'); // slice order preserved: vecs[2] is still chunk 1
  });

  it('preprocesses with the worker\'s derived maxBodyRunes cap so offsets align', async () => {
    query.mockResolvedValueOnce({ rows: [{ subject: 'S', body_text: 'b', body_html: '' }] });
    preprocess.mockReturnValue({ text: '' });
    chunkText.mockReturnValue({ spans: [] });
    await matchesInMessage('m1', 'q', 0, { accountIds: ['a'] });
    // worker.js _embedBatch: maxInputChars(100) * MAX_SPANS(64) * RAW_BODY_MULT(16)
    expect(preprocess).toHaveBeenCalledWith('S', 'b', 0, { maxBodyRunes: 102400 });
  });

  it('never overrides an explicitly configured maxBodyRunes', async () => {
    resolveActiveGenerationFromConfig.mockResolvedValue({
      cfg: { ...cfg, preprocess: { maxBodyRunes: 7 } }, generation: { id: 1 },
    });
    query.mockResolvedValueOnce({ rows: [{ subject: 'S', body_text: 'b', body_html: '' }] });
    preprocess.mockReturnValue({ text: '' });
    chunkText.mockReturnValue({ spans: [] });
    await matchesInMessage('m1', 'q', 0, { accountIds: ['a'] });
    expect(preprocess).toHaveBeenCalledWith('S', 'b', 0, { maxBodyRunes: 7 });
  });
});

describe('matchFromChunk', () => {
  it('re-derives snippet + raw-body byte char_offset from best_chunk, without embedding', async () => {
    const subject = 'Trip';
    const body = 'the flight itinerary is attached and confirmed';
    query.mockResolvedValueOnce({ rows: [{ subject, body_text: body, body_html: '' }] });
    preprocess.mockReturnValue({ text: 'Subject: Trip\n\n' + body });
    const prefixLen = [...'Subject: Trip\n\n'].length;           // code points before the body
    const startCp = prefixLen + body.indexOf('flight itinerary');
    const endCp = startCp + 'flight itinerary'.length;
    const m = await matchFromChunk('m1', { chunk_index: 0, char_start: startCp, char_end: endCp, score: 0.87 }, { accountIds: ['acc-1'] });
    expect(m.snippet).toBe('flight itinerary');
    expect(m.score).toBe(0.87);
    expect(m.char_offset).toBe(Buffer.from(body, 'utf8').indexOf(Buffer.from('flight itinerary', 'utf8')));
    expect(m.line).toBe(1);
    expect(mockEmbed).not.toHaveBeenCalled(); // matchFromChunk never embeds — phase 4 already scored
    expect(query.mock.calls[0][1]).toEqual(['m1', ['acc-1']]); // scoped to the token's accounts
  });

  it('returns null for an out-of-scope message', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await matchFromChunk('m1', { char_start: 0, char_end: 5, score: 1 }, { accountIds: ['acc-1'] })).toBeNull();
  });

  it('returns null when the code-point range is empty', async () => {
    query.mockResolvedValueOnce({ rows: [{ subject: 'S', body_text: 'body', body_html: '' }] });
    preprocess.mockReturnValue({ text: 'Subject: S\n\nbody' });
    expect(await matchFromChunk('m1', { char_start: 5, char_end: 5, score: 1 }, { accountIds: ['acc-1'] })).toBeNull();
  });

  it('preprocesses with the worker\'s derived maxBodyRunes cap so stored offsets align', async () => {
    query.mockResolvedValueOnce({ rows: [{ subject: 'S', body_text: 'body', body_html: '' }] });
    preprocess.mockReturnValue({ text: 'Subject: S\n\nbody' });
    await matchFromChunk('m1', { char_start: 12, char_end: 16, score: 1 }, { accountIds: ['acc-1'] });
    expect(preprocess).toHaveBeenCalledWith('S', 'body', 0, { maxBodyRunes: 102400 });
  });
});

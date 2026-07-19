// Golden-fixture parity: msgvault's wire shapes (internal/query/models.go,
// internal/mcp/handlers.go, internal/vector/stats.go) transcribed as key+type
// shapes and diffed field-for-field against Mailflow's output. Drives REAL code
// end-to-end with only I/O mocked, so the diff pins the true wire shape.
//
// Divergences the diff intentionally accepts: D6 UUID-string ids (token 'uuid'
// matches any string), ≤1 semantic excerpt, and the capitalized-key split
// (Address/AttachmentInfo/AccountInfo/AggregateRow/TotalStats have no Go json
// tags → Go-default caps; MessageSummary/getMessageResponse are snake_case).
//
// Shapes live inline here (not separate fixtures/*.json files) — a deliberate
// consolidation; the diffing is identical and the reference sits beside the test.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../services/search/queryParser.js', () => ({ parseQuery: vi.fn(() => ({ filters: [], terms: [{ value: 'hello', negate: false }], unsupported: [], errors: [] })) }));
vi.mock('../services/search/searchService.js', () => ({ search: vi.fn() }));
vi.mock('../services/embeddings/chunkmatch.js', () => ({ matchFromChunk: vi.fn(), matchesInMessage: vi.fn() }));
vi.mock('../services/embeddings/generations.js', () => ({ activeGeneration: vi.fn(), buildingGeneration: vi.fn(), chunkCount: vi.fn() }));
vi.mock('../services/embeddings/hybrid.js', () => ({ resolveActiveGenerationFromConfig: vi.fn() }));
vi.mock('../services/embeddings/vectorStore.js', () => ({ loadVector: vi.fn(), annSearch: vi.fn() }));
vi.mock('../services/embeddings/config.js', () => ({ generationFingerprint: vi.fn(() => 'fp'), resolveEmbedConfig: vi.fn(async () => ({ enabled: true, model: 'm', dimension: 2, preprocess: {}, maxInputChars: 100 })) }));

import { query, withTransaction } from '../services/db.js';
import { search } from '../services/search/searchService.js';
import * as generations from '../services/embeddings/generations.js';
import { resolveActiveGenerationFromConfig } from '../services/embeddings/hybrid.js';
import { loadVector, annSearch } from '../services/embeddings/vectorStore.js';
import { matchFromChunk } from '../services/embeddings/chunkmatch.js';
import { rowToMessageSummary, rowToMessageDetail } from './engineAdapter.js';
import { handleSearchMetadata, handleSearchMessageBodies, handleSemanticSearchMessages } from './searchTools.js';
import {
  handleGetMessage, handleListMessages, handleGetStats, handleAggregate,
  handleFindSimilarMessages, handleSearchInMessage, handleStageDeletion, handleSearchByDomains,
} from './messageTools.js';
import { HANDLERS } from './tools.js';
import { mockSurfaceDrift } from '../testSupport/mockSurface.js';

// ---- transcribed reference shapes ---------------------------------------------
const Address = { Email: 'string', Name: 'string' };
const AttachmentInfo = { ID: 'int', Filename: 'string', MimeType: 'string', Size: 'int', ContentHash: 'string', URL: 'string', StoragePath: 'string' };
const Generation = { id: 'int', model: 'string', dimension: 'int', fingerprint: 'string', state: 'string' };
const MessageSummary = {
  id: 'uuid', 'source_id?': 'uuid', source_message_id: 'string', conversation_id: 'uuid',
  source_conversation_id: 'string', subject: 'string', snippet: 'string',
  from_email: 'string', from_name: 'string', 'to?': [Address], 'cc?': [Address],
  sent_at: 'string', size_estimate: 'int', has_attachments: 'bool',
  attachment_count: 'int', labels: ['string'], message_type: 'string',
};
const Match = { snippet: 'string', 'char_offset?': 'int', 'line?': 'int', 'score?': 'number' };
// hybridScoreBreakdown (handlers.go:563-572): every field omitempty — rrf only
// fuses in mode=hybrid, subject_boosted only when true.
const HybridScore = { 'rrf?': 'number', 'bm25?': 'number', 'vector?': 'number', 'subject_boosted?': 'bool' };
// searchMessageItem (handlers.go:331-342): MessageSummary + matches/
// matches_truncated/score, all three Go-omitempty.
const SearchMessageItem = { ...MessageSummary, 'matches?': [Match], 'matches_truncated?': 'bool', 'score?': HybridScore };
// searchMessageBodiesResponse (handlers.go:586-595): paginated (no-total) +
// mode/pool_saturated/generation — shared by keyword and vector/hybrid modes.
const SearchBodiesEnvelope = {
  data: [SearchMessageItem], total: 'int', returned: 'int', offset: 'int', has_more: 'bool',
  mode: 'string', pool_saturated: 'bool', generation: Generation,
};
const SHAPES = {
  message_summary: MessageSummary,
  message_detail: { ...MessageSummary, from: [Address], to: [Address], cc: [Address], bcc: [Address], body_text: 'string', body_html: 'string', attachments: [AttachmentInfo] },
  search_metadata: { data: [MessageSummary], total: 'int', returned: 'int', offset: 'int', has_more: 'bool' },
  list_messages: { data: [MessageSummary], total: 'int', returned: 'int', offset: 'int', has_more: 'bool' },
  get_message: {
    id: 'uuid', source_message_id: 'string', conversation_id: 'uuid', source_conversation_id: 'string',
    subject: 'string', 'message_type?': 'string', snippet: 'string', sent_at: 'string',
    size_estimate: 'int', has_attachments: 'bool', from: [Address], to: [Address], cc: [Address], bcc: [Address],
    body_text: 'string', body_html: 'string', 'body_format?': 'string', body_length: 'int',
    body_returned: 'int', offset: 'int', has_more: 'bool', labels: ['string'], attachments: [AttachmentInfo],
  },
  get_stats: {
    stats: { MessageCount: 'int', ActiveMessageCount: 'int', SourceDeletedMessageCount: 'int', TotalSize: 'int', AttachmentCount: 'int', AttachmentSize: 'int', LabelCount: 'int', AccountCount: 'int' },
    accounts: [{ ID: 'uuid', SourceType: 'string', Identifier: 'string', DisplayName: 'string' }],
    'vector_search?': { enabled: 'bool', active_generation: { id: 'int', model: 'string', dimension: 'int', fingerprint: 'string', state: 'string', 'activated_at?': 'string', message_count: 'int' }, 'building_generation?': {}, missing_embeddings_total: 'int' },
  },
  aggregate: [{ Key: 'string', Count: 'int', TotalSize: 'int', AttachmentSize: 'int', AttachmentCount: 'int', TotalUnique: 'int' }],
  find_similar: { seed_message_id: 'uuid', returned: 'int', generation: Generation, messages: [MessageSummary] },
  search_in_message: { data: [Match], total: 'int', returned: 'int', offset: 'int', has_more: 'bool' },
  stage_deletion: { batch_id: 'uuid', message_count: 'int', status: 'string', next_step: 'string' },
  search_message_bodies: SearchBodiesEnvelope,
  semantic_search_messages: SearchBodiesEnvelope,
  search_by_domains: [MessageSummary], // raw array, no envelope (handlers.go:1984-1989)
  ping: { pong: 'bool' }, // Mailflow-specific health tool — no msgvault counterpart (documented divergence)
};

// ---- diffKeys: [] on parity, else a list of divergence paths -------------------
function typeOk(val, token) {
  const t = token.replace(/\?$/, '');
  if (t.includes('uuid')) return typeof val === 'string'; // D6 id divergence
  if (t === 'string') return typeof val === 'string';
  if (t === 'int' || t === 'number' || t === 'float') return typeof val === 'number';
  if (t === 'bool') return typeof val === 'boolean';
  return true;
}
function isOptional(shapeKey, shapeVal) {
  return shapeKey.endsWith('?') || (typeof shapeVal === 'string' && shapeVal.endsWith('?'));
}
function diffKeys(actual, shape, path = '$') {
  const out = [];
  if (typeof shape === 'string') {
    if (!typeOk(actual, shape)) out.push(`${path}: type mismatch (want ${shape}, got ${typeof actual})`);
    return out;
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(actual)) { out.push(`${path}: want array, got ${typeof actual}`); return out; }
    actual.forEach((a, i) => out.push(...diffKeys(a, shape[0], `${path}[${i}]`)));
    return out;
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) { out.push(`${path}: want object, got ${actual === null ? 'null' : typeof actual}`); return out; }
  const realKeys = new Set();
  for (const sk of Object.keys(shape)) {
    const k = sk.endsWith('?') ? sk.slice(0, -1) : sk;
    realKeys.add(k);
    if (!(k in actual)) { if (!isOptional(sk, shape[sk])) out.push(`${path}.${k}: missing`); continue; }
    out.push(...diffKeys(actual[k], shape[sk], `${path}.${k}`));
  }
  for (const k of Object.keys(actual)) if (!realKeys.has(k)) out.push(`${path}.${k}: extra (not in msgvault shape)`);
  return out;
}

const realRow = {
  id: '11111111-1111-1111-1111-111111111111', account_id: 'acc-1', message_id: '<abc@x>', thread_id: 'tid-9',
  subject: 'Hi', snippet: 's', from_email: 'a@b.com', from_name: 'A',
  to_addresses: [{ name: 'C', email: 'c@d.com' }], cc_addresses: [{ name: 'E', email: 'e@f.com' }],
  date: new Date('2024-01-01T00:00:00Z'), has_attachments: true,
  attachments: [{ part: '2', filename: 'f.pdf', type: 'application/pdf', size: 10 }],
  flags: ['\\Seen'], folder: 'INBOX', body_text: 'hello world', body_html: '<p>hello world</p>',
};
const jsonOf = (r) => JSON.parse(r.content[0].text);
const scope = { userId: 'u', accountIds: ['acc-1'] };

beforeEach(() => {
  query.mockReset(); withTransaction.mockReset(); search.mockReset(); matchFromChunk.mockReset();
  generations.activeGeneration.mockReset(); generations.buildingGeneration.mockReset(); generations.chunkCount.mockReset();
  resolveActiveGenerationFromConfig.mockReset(); loadVector.mockReset(); annSearch.mockReset();
});

// Every function this suite vi.mock()s must actually exist on its real module —
// a renamed/never-implemented seam (e.g. generations.chunkCount) otherwise passes
// here while throwing live. Catches the missing/renamed-export drift class only,
// not value-shape drift.
describe('mock-drift guard: mocked seams exist on their real modules', () => {
  // hybrid.js is intentionally omitted: importActual runs its module body, which
  // references vectorStore.fusedSearch — not in this suite's vectorStore mock.
  it.each([
    ['generations', () => generations, '../services/embeddings/generations.js'],
    ['vectorStore', () => ({ loadVector, annSearch }), '../services/embeddings/vectorStore.js'],
    ['searchService', () => ({ search }), '../services/search/searchService.js'],
  ])('%s mock surface matches the real module', async (_name, getMock, path) => {
    const real = await vi.importActual(path);
    expect(mockSurfaceDrift(getMock(), real)).toEqual([]);
  });
});

describe('golden parity: structural mappers', () => {
  it('rowToMessageSummary matches MessageSummary (snake_case + capitalized Address, id divergence excepted)', () => {
    // Round-trip through JSON so absent optional keys behave like the wire.
    const s = JSON.parse(JSON.stringify(rowToMessageSummary(realRow)));
    expect(diffKeys(s, SHAPES.message_summary)).toEqual([]);
  });
  it('rowToMessageDetail matches MessageDetail (capitalized AttachmentInfo)', () => {
    const d = JSON.parse(JSON.stringify(rowToMessageDetail(realRow)));
    expect(diffKeys(d, SHAPES.message_detail)).toEqual([]);
  });
});

describe('golden parity: message tool envelopes', () => {
  it('get_message → getMessageResponse', async () => {
    query.mockResolvedValueOnce({ rows: [realRow] });
    const b = jsonOf(await handleGetMessage({ id: realRow.id }, scope));
    expect(diffKeys(b, SHAPES.get_message)).toEqual([]);
  });

  it('list_messages → paginated MessageSummary envelope', async () => {
    query.mockResolvedValueOnce({ rows: [realRow] }); // listMessages
    const b = jsonOf(await handleListMessages({}, scope));
    expect(diffKeys(b, SHAPES.list_messages)).toEqual([]);
  });

  it('aggregate → capitalized AggregateRow array', async () => {
    query.mockResolvedValueOnce({ rows: [{ key: 'a@b.com', count: '3', total_size: '10', attachment_count: '1', total_unique: '5' }] });
    const b = jsonOf(await handleAggregate({ group_by: 'sender' }, scope));
    expect(diffKeys(b, SHAPES.aggregate)).toEqual([]);
  });

  it('get_stats → {stats, accounts, vector_search} with capitalized structs', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ message_count: '10', active_count: '9', deleted_count: '1', total_size: '5000', attachment_count: '3', label_count: '2' }] }) // getTotalStats
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1', protocol: 'imap', email_address: 'a@b.com', name: 'Work' }] }) // listAccounts
      .mockResolvedValueOnce({ rows: [{ n: '4' }] }); // collectStats missingCount
    generations.activeGeneration.mockResolvedValue({ id: 2, model: 'm', dimension: 1536, fingerprint: 'fp', state: 'active', activatedAt: 1704067200 }); // epoch seconds → RFC3339 wire
    generations.buildingGeneration.mockResolvedValue(null);
    generations.chunkCount.mockResolvedValue(1000);
    const b = jsonOf(await handleGetStats({}, scope));
    expect(diffKeys(b, SHAPES.get_stats)).toEqual([]);
    // RFC3339 without sub-second digits (vector/stats.go:146-153 formatTime).
    expect(b.vector_search.active_generation.activated_at).toBe('2024-01-01T00:00:00Z');
  });

  it('find_similar_messages → seed/returned/generation/messages', async () => {
    resolveActiveGenerationFromConfig.mockResolvedValue({
      cfg: { enabled: true, model: 'm', dimension: 2, preprocess: {}, maxInputChars: 100 },
      generation: { id: 3, model: 'm', dimension: 2, fingerprint: 'fp', state: 'active' },
    });
    loadVector.mockResolvedValue([0.1, 0.2]);
    annSearch.mockResolvedValue([{ messageId: realRow.id, score: 0.9, rank: 1 }]);
    query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // messageInScope(seed)
      .mockResolvedValueOnce({ rows: [realRow] }); // getMessageSummariesByIDs
    const b = jsonOf(await handleFindSimilarMessages({ message_id: realRow.id }, scope));
    expect(diffKeys(b, SHAPES.find_similar)).toEqual([]);
  });

  it('search_in_message (keyword) → Match envelope with byte char_offset', async () => {
    query.mockResolvedValueOnce({ rows: [realRow] }); // getMessage
    const b = jsonOf(await handleSearchInMessage({ id: realRow.id, query: 'hello' }, scope));
    expect(diffKeys(b, SHAPES.search_in_message)).toEqual([]);
    expect(b.data[0].char_offset).toBe(Buffer.from(realRow.body_text, 'utf8').indexOf(Buffer.from('hello', 'utf8')));
  });

  it('stage_deletion → {batch_id, message_count, status, next_step}', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: realRow.id }] }); // id resolution
    withTransaction.mockImplementation(async (fn) => fn({ query: vi.fn(async (text) => (/INSERT INTO mcp_deletion_batches/.test(text) ? { rows: [{ id: 'batch-1' }] } : { rows: [] })) }));
    const b = jsonOf(await handleStageDeletion({ domain: 'linkedin.com' }, scope));
    expect(diffKeys(b, SHAPES.stage_deletion)).toEqual([]);
    expect(b.status).toBe('pending'); // msgvault manifest.StatusPending literal (manifest.go:25)
  });
});

describe('golden parity: search tool envelopes', () => {
  it('search_metadata → paginated MessageSummary envelope (real hydration)', async () => {
    search.mockResolvedValue({ messages: [{ id: realRow.id }], total: 1, mode: 'lexical', page: { offset: 0, limit: 20, hasMore: false } });
    query.mockResolvedValueOnce({ rows: [realRow] }); // getMessageSummariesByIDs hydration
    const b = jsonOf(await handleSearchMetadata({ query: 'x' }, scope));
    expect(diffKeys(b, SHAPES.search_metadata)).toEqual([]);
    // Go time.Time wire format: RFC3339 with no sub-second digits.
    expect(b.data[0].sent_at).toBe('2024-01-01T00:00:00Z');
  });

  it('search_message_bodies → searchMessageItem envelope; matches/matches_truncated omitted when empty/false (handlers.go:339-341)', async () => {
    search.mockResolvedValue({
      messages: [
        { id: realRow.id, body_text: 'hello world, hello again' }, // 1 merged excerpt
        { id: 'no-hit-1111-1111-1111-111111111111', body_text: 'nothing relevant' }, // 0 excerpts
      ],
      mode: 'lexical', page: { offset: 0, limit: 20, hasMore: false },
    });
    query.mockResolvedValueOnce({ rows: [realRow, { ...realRow, id: 'no-hit-1111-1111-1111-111111111111' }] }); // hydration
    const b = jsonOf(await handleSearchMessageBodies({ query: 'hello' }, scope));
    expect(diffKeys(b, SHAPES.search_message_bodies)).toEqual([]);
    expect(b.mode).toBe('keyword');
    expect(b.total).toBe(-1); // body search never counts
    expect(b.generation).toEqual({ id: 0, model: '', dimension: 0, fingerprint: '', state: '' });
    // diffKeys accepts optional keys whether present or absent, so the
    // omitempty contract is asserted explicitly on both sides:
    expect(b.data[0]).toHaveProperty('matches');
    expect(b.data[0]).not.toHaveProperty('matches_truncated'); // false → omitted
    expect(b.data[1]).not.toHaveProperty('matches');           // empty → omitted
    expect(b.data[1]).not.toHaveProperty('matches_truncated');
  });

  it('semantic_search_messages → mode/pool_saturated/generation envelope; explain score omitempty (handlers.go:563-572)', async () => {
    search.mockResolvedValue({
      messages: [{
        message_id: realRow.id, id: realRow.id,
        best_chunk: { chunk_index: 0, char_start: 0, char_end: 10, score: 0.9 },
        score: { rrf: 0.03, bm25: 1.2, vector: 0.9, subject_boosted: false },
      }],
      mode: 'vector', page: { offset: 0, limit: 20, hasMore: false },
      pool_saturated: true,
      generation: { id: 3, model: 'm', dimension: 2, fingerprint: 'fp', state: 'active' },
    });
    matchFromChunk.mockResolvedValue({ char_offset: 5, snippet: 'hello', line: 1, score: 0.9 });
    query.mockResolvedValueOnce({ rows: [realRow] }); // hydration
    const b = jsonOf(await handleSemanticSearchMessages({ query: 'hello', mode: 'vector', explain: true }, scope));
    expect(diffKeys(b, SHAPES.semantic_search_messages)).toEqual([]);
    expect(b.mode).toBe('vector');
    expect(b.pool_saturated).toBe(true);
    expect(b.total).toBe(-1);
    expect(b.generation).toEqual({ id: 3, model: 'm', dimension: 2, fingerprint: 'fp', state: 'active' });
    // omitempty asserted explicitly: no rrf in mode=vector (nothing to fuse),
    // no subject_boosted when false.
    expect(b.data[0].score).toEqual({ bm25: 1.2, vector: 0.9 });
    expect(b.data[0].matches).toHaveLength(1); // ≤1 excerpt — documented divergence from msgvault's ≤5
  });

  it('search_by_domains → raw MessageSummary array, no envelope (handlers.go:1951-1989)', async () => {
    query.mockResolvedValueOnce({ rows: [realRow] });
    const b = jsonOf(await handleSearchByDomains({ domains: 'b.com' }, scope));
    expect(diffKeys(b, SHAPES.search_by_domains)).toEqual([]);
    expect(b[0].sent_at).toBe('2024-01-01T00:00:00Z');
  });

  it('ping → {pong:true} (Mailflow-specific health tool)', async () => {
    const b = jsonOf(await HANDLERS.ping({}, scope));
    expect(diffKeys(b, SHAPES.ping)).toEqual([]);
    expect(b.pong).toBe(true);
  });
});

describe('no SQL in MCP handler modules (one-seam invariant)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (n) => readFileSync(join(here, n), 'utf8');
  for (const file of ['searchTools.js', 'messageTools.js']) {
    it(`${file} contains no raw SQL or db.js import`, () => {
      const src = read(file);
      expect(src).not.toMatch(/\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE FROM\b/);
      expect(src).not.toMatch(/from '\.\.\/services\/db\.js'/);
      expect(src).not.toMatch(/\bpool\b/);
    });
  }
});

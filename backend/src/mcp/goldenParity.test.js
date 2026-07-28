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
vi.mock('../services/mailbox/move.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    bulkMoveToFolder: vi.fn(),
    resolveMovedIds: vi.fn(),
  };
});
vi.mock('../services/mailbox/archive.js', async (orig) => {
  const actual = await orig();
  return { ...actual, bulkArchive: vi.fn() };
});
vi.mock('../services/mailbox/trash.js', async (orig) => {
  const actual = await orig();
  return { ...actual, bulkTrash: vi.fn() };
});
vi.mock('../services/mailbox/snooze.js', async (orig) => {
  const actual = await orig();
  return { ...actual, snoozeConversation: vi.fn() };
});
vi.mock('../services/gtd/actions.js', async (orig) => {
  const actual = await orig();
  return { ...actual, gtdDone: vi.fn() };
});

import { query, withTransaction } from '../services/db.js';
import { search } from '../services/search/searchService.js';
import * as generations from '../services/embeddings/generations.js';
import { resolveActiveGenerationFromConfig } from '../services/embeddings/hybrid.js';
import { loadVector, annSearch } from '../services/embeddings/vectorStore.js';
import { matchFromChunk } from '../services/embeddings/chunkmatch.js';
import { ALL_SCOPES } from './auth.js';
import { rowToMessageSummary, rowToMessageDetail } from './engineAdapter.js';
import { handleSearchMetadata, handleSearchMessageBodies, handleSemanticSearchMessages } from './searchTools.js';
import {
  handleGetMessage, handleListMessages, handleGetStats, handleAggregate,
  handleFindSimilarMessages, handleSearchInMessage, handleStageDeletion, handleSearchByDomains,
} from './messageTools.js';
import {
  handleCreateDraft, handleDeleteDraft, handleUpdateDraft,
} from './draftTools.js';
import {
  handleListOutbox, handleRecallEmail, handleSendDraft, handleSendEmail,
  handleUnsendEmail,
} from './sendTools.js';
import {
  handleForwardEmail, handleReplyAllEmail, handleReplyEmail,
} from './composeTools.js';
import {
  handleArchiveMessages,
  handleGtdDone,
  handleMoveMessages,
  handleSnoozeMessage,
  handleTrashMessages,
} from './mailboxTools.js';
import {
  bulkMoveToFolder,
  resolveMovedIds,
} from '../services/mailbox/move.js';
import { bulkArchive } from '../services/mailbox/archive.js';
import { bulkTrash } from '../services/mailbox/trash.js';
import { snoozeConversation } from '../services/mailbox/snooze.js';
import { gtdDone } from '../services/gtd/actions.js';
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
const WriteAddress = { name: 'string', email: 'string' };
const WriteAttachment = { filename: 'string', size: 'int', 'source?': 'string' };
const WriteReceipt = {
  from: WriteAddress,
  to: [WriteAddress],
  cc: [WriteAddress],
  bcc: [WriteAddress],
  subject: 'string',
  attachments: [WriteAttachment],
};
const ImmediateSend = {
  sent: 'bool',
  message_id: 'string',
  ...WriteReceipt,
  sent_copy_saved: 'bool',
  folder: 'string',
};
const QueuedSend = {
  queued: 'bool',
  outbox_id: 'string',
  send_at: 'string',
  undo_seconds: 'int',
  from: {},
  to: [WriteAddress],
  cc: [WriteAddress],
  bcc: [WriteAddress],
  subject: 'string',
  attachments: [WriteAttachment],
  note: 'string',
};
const RecipientsComputed = {
  reply_target: 'string',
  excluded_self: ['string'],
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
  write_receipt: WriteReceipt,
  create_or_update_draft: {
    draft_uid: 'int',
    folder: 'string',
    message_id: 'string',
    receipt: { message_id: 'string', ...WriteReceipt },
  },
  delete_draft: { deleted: 'bool', draft_uid: 'int', folder: 'string' },
  immediate_send: ImmediateSend,
  queued_send: QueuedSend,
  reply_send: {
    sent: 'bool',
    recipients_computed: RecipientsComputed,
    message_id: 'string',
    in_reply_to: 'string',
    references: 'string',
    ...WriteReceipt,
    sent_copy_saved: 'bool',
    folder: 'string',
  },
  forward_send: {
    ...ImmediateSend,
    attachments: [{ filename: 'string', size: 'int', source: 'string' }],
  },
  unsend_email: {
    cancelled: 'bool',
    outbox_id: 'string',
    subject: 'string',
    to: ['string'],
  },
  list_outbox: {
    data: [{
      id: 'string',
      subject: 'string',
      to_preview: ['string'],
      send_at: 'string',
    }],
    total: 'int',
    returned: 'int',
    offset: 'int',
    has_more: 'bool',
  },
  recall_cancelled_before_send: {
    recalled: 'string',
    outbox_id: 'string',
    subject: 'string',
    to: ['string'],
  },
  recall_not_possible: {
    recalled: 'string',
    note: 'string',
    sent_copy_deleted: 'bool',
    followup_draft: { draft_uid: 'int', folder: 'string' },
  },
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
const writeAccount = {
  id: 'acc-1',
  user_id: 'u',
  email_address: 'sender@example.com',
  sender_name: 'Sender',
  signature: null,
  folder_mappings: { drafts: 'Drafts' },
};
const composeSource = {
  id: '22222222-2222-4222-8222-222222222222',
  account_id: 'acc-1',
  uid: 42,
  folder: 'Sent',
  message_id: '<original@example.com>',
  thread_references: '<root@example.com>',
  subject: 'Topic',
  from_name: 'Original Sender',
  from_email: 'original@example.com',
  reply_to: [{ name: 'Reply Desk', email: 'reply@example.com' }],
  to_addresses: [{ name: 'Sender', email: 'sender@example.com' }],
  cc_addresses: [{ name: 'Colleague', email: 'colleague@example.com' }],
  body_text: 'Original body',
  body_html: '<p>Original body</p>',
  attachments: [{ part: '2', filename: 'deck.pdf', size: 2_144_000 }],
  date: new Date('2026-07-28T09:00:00Z'),
};
const immediateReceipt = {
  from: { name: 'Sender', email: 'sender@example.com' },
  to: [{ name: 'Recipient', email: 'recipient@example.com' }],
  cc: [],
  bcc: [],
  subject: 'Subject',
  attachments: [{ filename: 'note.txt', size: 5 }],
  messageId: '<sent@example.com>',
  sentCopySaved: true,
  folder: 'Sent',
};
const jsonOf = (r) => JSON.parse(r.content[0].text);
const scope = { userId: 'u', accountIds: ['acc-1'], scopes: ALL_SCOPES };

function writeDeps(overrides = {}) {
  return {
    draftService: {
      saveDraft: vi.fn().mockResolvedValue({
        uid: 42,
        folder: 'Drafts',
        messageId: '<draft@example.com>',
      }),
      deleteDraft: vi.fn().mockResolvedValue({ ok: true }),
    },
    sendService: {
      sendOrEnqueue: vi.fn().mockResolvedValue({
        ok: true,
        messageId: '<sent@example.com>',
        sentCopySaved: true,
        receipt: immediateReceipt,
      }),
    },
    outboxService: {
      normalizeUndoWindow: vi.fn((requested, preference) => requested ?? preference ?? 0),
      cancel: vi.fn().mockResolvedValue({ cancelled: true }),
      listPending: vi.fn().mockResolvedValue([]),
    },
    imapManager: {
      permanentDeleteMessage: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

function mockQueryRows(...rowSets) {
  for (const rows of rowSets) {
    query.mockResolvedValueOnce({ rows, rowCount: rows.length });
  }
}

beforeEach(() => {
  query.mockReset(); withTransaction.mockReset(); search.mockReset(); matchFromChunk.mockReset();
  generations.activeGeneration.mockReset(); generations.buildingGeneration.mockReset(); generations.chunkCount.mockReset();
  resolveActiveGenerationFromConfig.mockReset(); loadVector.mockReset(); annSearch.mockReset();
  bulkMoveToFolder.mockReset(); resolveMovedIds.mockReset(); bulkArchive.mockReset();
  bulkTrash.mockReset(); snoozeConversation.mockReset(); gtdDone.mockReset();
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
  // These unchanged get/list cases are the read-wire regression guard for the
  // write-handler `(args, scope, deps)` stack.
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

describe('golden parity: write tool envelopes', () => {
  it('create_draft → draft identifier plus nested write receipt', async () => {
    const deps = writeDeps();
    mockQueryRows([writeAccount]);

    const b = jsonOf(await handleCreateDraft({
      account: 'sender@example.com',
      to: ['Recipient <recipient@example.com>'],
      subject: 'Subject',
      attachments: [{
        filename: 'note.txt',
        content: 'aGVsbG8=',
        content_type: 'text/plain',
      }],
    }, scope, deps));

    expect(diffKeys(b, SHAPES.create_or_update_draft)).toEqual([]);
  });

  it('update_draft → replacement identifier plus nested write receipt', async () => {
    const deps = writeDeps();
    deps.draftService.saveDraft.mockResolvedValue({
      uid: 43,
      folder: 'Drafts',
      messageId: '<updated-draft@example.com>',
    });
    mockQueryRows(
      [writeAccount],
      [{
        uid: 42,
        folder: 'Drafts',
        from_email: 'sender@example.com',
        to_addresses: [{ name: 'Recipient', email: 'recipient@example.com' }],
        cc_addresses: [],
        bcc_addresses: [],
        subject: 'Subject',
        body_text: 'Original body',
        body_html: null,
        attachments: [],
      }],
    );

    const b = jsonOf(await handleUpdateDraft({
      account: 'sender@example.com',
      draft_uid: 42,
      body: 'Updated body',
    }, scope, deps));

    expect(diffKeys(b, SHAPES.create_or_update_draft)).toEqual([]);
    expect(b.draft_uid).toBe(43);
  });

  it('delete_draft → permanent-deletion identifier envelope', async () => {
    const deps = writeDeps();
    mockQueryRows(
      [writeAccount],
      [{ uid: 42, folder: 'Drafts' }],
    );

    const b = jsonOf(await handleDeleteDraft({
      account: 'sender@example.com',
      draft_uid: 42,
    }, scope, deps));

    expect(diffKeys(b, SHAPES.delete_draft)).toEqual([]);
  });

  it('send_email immediate → full write receipt', async () => {
    const deps = writeDeps();
    mockQueryRows([writeAccount], [{ preferences: { undoSendSeconds: 0 } }]);

    const b = jsonOf(await handleSendEmail({
      account: 'sender@example.com',
      to: ['Recipient <recipient@example.com>'],
      subject: 'Subject',
      undo_send_seconds: 0,
    }, scope, deps));

    expect(diffKeys(b, SHAPES.immediate_send)).toEqual([]);
  });

  it('send_email queued → placeholder receipt with undo metadata', async () => {
    const deps = writeDeps();
    deps.outboxService.normalizeUndoWindow.mockReturnValue(30);
    deps.sendService.sendOrEnqueue.mockResolvedValue({
      queued: true,
      outboxId: 'outbox-1',
      sendAt: new Date('2026-07-28T10:00:30.000Z'),
      undoSeconds: 30,
    });
    mockQueryRows([writeAccount], [{ preferences: { undoSendSeconds: 30 } }]);

    const b = jsonOf(await handleSendEmail({
      account: 'sender@example.com',
      to: ['recipient@example.com'],
      subject: 'Queued subject',
    }, scope, deps));

    expect(diffKeys(b, SHAPES.queued_send)).toEqual([]);
    expect(b.from).toEqual({});
    expect(b.to).toEqual([]);
  });

  it('send_draft immediate → same full write receipt as send_email', async () => {
    const deps = writeDeps();
    mockQueryRows(
      [writeAccount],
      [{
        uid: 42,
        folder: 'Drafts',
        from_email: 'sender@example.com',
        to_addresses: [{ name: 'Recipient', email: 'recipient@example.com' }],
        cc_addresses: [],
        bcc_addresses: [],
        subject: 'Subject',
        body_text: 'Draft body',
        body_html: '',
      }],
      [{ preferences: { undoSendSeconds: 0 } }],
    );

    const b = jsonOf(await handleSendDraft({
      account: 'sender@example.com',
      draft_uid: 42,
      undo_send_seconds: 0,
    }, scope, deps));

    expect(diffKeys(b, SHAPES.immediate_send)).toEqual([]);
  });

  it.each([
    ['reply_email', handleReplyEmail],
    ['reply_all_email', handleReplyAllEmail],
  ])('%s → threading plus recipients_computed receipt', async (_name, handler) => {
    const deps = writeDeps();
    deps.sendService.sendOrEnqueue.mockResolvedValue({
      ok: true,
      receipt: {
        ...immediateReceipt,
        to: [{ name: 'Reply Desk', email: 'reply@example.com' }],
        subject: 'Re: Topic',
        attachments: [],
        messageId: '<reply@example.com>',
      },
    });
    mockQueryRows(
      [composeSource],
      [writeAccount],
      [],
      [{ preferences: { undoSendSeconds: 0 } }],
    );

    const b = jsonOf(await handler({
      message_id: composeSource.id,
      body: 'Thanks',
      no_quote: true,
      undo_send_seconds: 0,
    }, scope, deps));

    expect(diffKeys(b, SHAPES.reply_send)).toEqual([]);
    expect(b.recipients_computed.reply_target).toBe('reply@example.com');
  });

  it('forward_email → immediate receipt with forwarded attachment source', async () => {
    const deps = writeDeps();
    deps.sendService.sendOrEnqueue.mockResolvedValue({
      ok: true,
      receipt: {
        ...immediateReceipt,
        subject: 'Fwd: Topic',
        attachments: [{ filename: 'deck.pdf', size: 2_144_000 }],
        messageId: '<forward@example.com>',
      },
    });
    mockQueryRows(
      [composeSource],
      [writeAccount],
      [],
      [{ preferences: { undoSendSeconds: 0 } }],
    );

    const b = jsonOf(await handleForwardEmail({
      message_id: composeSource.id,
      to: ['Recipient <recipient@example.com>'],
      undo_send_seconds: 0,
    }, scope, deps));

    expect(diffKeys(b, SHAPES.forward_send)).toEqual([]);
    expect(b.attachments[0].source).toBe('forwarded');
  });

  it('unsend_email → cancelled outbox receipt', async () => {
    const deps = writeDeps();
    deps.outboxService.listPending.mockResolvedValue([{
      id: 'outbox-1',
      subject: 'Queued subject',
      to_preview: ['recipient@example.com'],
      send_at: new Date('2026-07-28T10:00:30.000Z'),
    }]);

    const b = jsonOf(await handleUnsendEmail({
      outbox_id: 'outbox-1',
    }, scope, deps));

    expect(diffKeys(b, SHAPES.unsend_email)).toEqual([]);
  });

  it('list_outbox → no-total pagination envelope', async () => {
    const deps = writeDeps();
    deps.outboxService.listPending.mockResolvedValue([{
      id: 'outbox-1',
      subject: 'Queued subject',
      to_preview: ['recipient@example.com'],
      send_at: new Date('2026-07-28T10:00:30.000Z'),
    }]);

    const b = jsonOf(await handleListOutbox({}, scope, deps));

    expect(diffKeys(b, SHAPES.list_outbox)).toEqual([]);
    expect(b.total).toBe(-1);
  });

  it('recall_email pending → cancelled_before_send envelope', async () => {
    const deps = writeDeps();
    deps.outboxService.listPending.mockResolvedValue([{
      id: 'outbox-1',
      subject: 'Queued subject',
      to_preview: ['recipient@example.com'],
    }]);

    const b = jsonOf(await handleRecallEmail({
      outbox_id: 'outbox-1',
    }, scope, deps));

    expect(diffKeys(b, SHAPES.recall_cancelled_before_send)).toEqual([]);
    expect(b.recalled).toBe('cancelled_before_send');
  });

  it('recall_email delivered → not_possible envelope with follow-up draft', async () => {
    const deps = writeDeps();
    deps.draftService.saveDraft.mockResolvedValue({
      uid: 57,
      folder: 'Drafts',
      messageId: '<followup@example.com>',
    });
    mockQueryRows(
      [],
      [composeSource],
      [writeAccount],
    );
    query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const b = jsonOf(await handleRecallEmail({
      message_id: composeSource.id,
    }, scope, deps));

    expect(diffKeys(b, SHAPES.recall_not_possible)).toEqual([]);
    expect(b.recalled).toBe('not_possible');
    expect(deps.sendService.sendOrEnqueue).not.toHaveBeenCalled();
  });
});

describe('golden parity: mailbox tool envelopes', () => {
  const id = '33333333-3333-4333-8333-333333333333';
  const secondId = '44444444-4444-4444-8444-444444444444';
  const newId = '55555555-5555-4555-8555-555555555555';
  const deps = { imapManager: {} };

  it('pins move_messages receipt keys', async () => {
    bulkMoveToFolder.mockResolvedValue({
      ok: true,
      movedDetails: [{ id, accountId: 'acc-1', uid: 110 }],
      failed: [],
      skippedAccounts: [],
    });
    resolveMovedIds.mockResolvedValue([{ id: newId, uid: 110 }]);

    expect(jsonOf(await handleMoveMessages({
      message_ids: [id],
      folder: 'Projects',
    }, scope, deps))).toEqual({
      ok: true,
      moved: [{ id, new_id: newId, uid: 110, folder: 'Projects' }],
      failed: [],
      skipped_accounts: [],
      resync_pending: false,
      note: 'message ids change on move; use new_id for follow-up calls',
    });
  });

  it('pins archive_messages receipt keys including destination_untracked', async () => {
    bulkArchive.mockResolvedValue({
      ok: true,
      archivedDetails: [
        {
          id,
          accountId: 'acc-1',
          folder: 'Archive',
          uid: 110,
          destinationUntracked: false,
        },
        {
          id: secondId,
          accountId: 'acc-1',
          folder: '[Gmail]/All Mail',
          uid: 111,
          destinationUntracked: true,
        },
      ],
      failed: [],
      noArchiveFolder: [],
    });
    resolveMovedIds.mockResolvedValue([{ id: newId, uid: 110 }]);

    expect(jsonOf(await handleArchiveMessages({
      message_ids: [id, secondId],
    }, scope, deps))).toEqual({
      ok: true,
      archived: [
        {
          id,
          new_id: newId,
          uid: 110,
          folder: 'Archive',
          destination_untracked: false,
        },
        {
          id: secondId,
          new_id: null,
          uid: 111,
          folder: '[Gmail]/All Mail',
          destination_untracked: true,
        },
      ],
      failed: [],
      no_archive_folder: [],
      resync_pending: false,
      note: 'message ids change on archive; use new_id for follow-up calls',
    });
  });

  it('pins trash_messages receipt keys including the refusal partition', async () => {
    bulkTrash.mockResolvedValue({
      ok: true,
      trashedDetails: [{
        id,
        accountId: 'acc-1',
        folder: 'Trash',
        uid: 110,
      }],
      failed: [],
      refused: [{
        id: secondId,
        folder: 'Trash',
        reason: 'already_in_trash_permanent_delete_required',
      }],
    });
    resolveMovedIds.mockResolvedValue([{ id: newId, uid: 110 }]);

    expect(jsonOf(await handleTrashMessages({
      message_ids: [id, secondId],
    }, scope, deps))).toEqual({
      ok: true,
      trashed: [{ id, new_id: newId, folder: 'Trash' }],
      failed: [],
      refused: [{
        id: secondId,
        folder: 'Trash',
        reason: 'already_in_trash_permanent_delete_required',
      }],
      resync_pending: false,
      next_step: 'use stage_deletion for permanent removal',
    });
  });

  it('pins snooze_message receipt keys', async () => {
    snoozeConversation.mockResolvedValue({
      ok: true,
      movedCount: 2,
      movedIds: [id, secondId],
      folder: 'Snoozed',
    });

    expect(jsonOf(await handleSnoozeMessage({
      message_id: id,
      until: new Date(Date.now() + 60_000).toISOString(),
    }, scope, deps))).toEqual({
      ok: true,
      moved_count: 2,
      sibling_ids: [secondId],
      folder: 'Snoozed',
    });
  });

  it('pins gtd_done partial-success receipt keys', async () => {
    gtdDone.mockResolvedValue({
      ok: true,
      removed: ['Watch'],
      archived: false,
      noArchiveFolder: false,
      archiveFailed: true,
    });

    const result = await handleGtdDone({
      message_id: id,
      states: ['watch'],
    }, scope, deps);

    expect(result.isError).toBeUndefined();
    expect(jsonOf(result)).toEqual({
      ok: true,
      removed: ['Watch'],
      archived: false,
      no_archive_folder: false,
      archive_failed: true,
    });
  });
});

describe('SQL is confined to MCP adapter seams', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (n) => readFileSync(join(here, n), 'utf8');
  for (const file of ['engineAdapter.js', 'accountAdapter.js']) {
    it(`${file} is an explicitly allowed SQL seam`, () => {
      expect(read(file)).toMatch(/from '\.\.\/services\/db\.js'/);
    });
  }
  for (const file of [
    'searchTools.js',
    'messageTools.js',
    'mailboxTools.js',
    'triageTools.js',
    'composeTools.js',
    'draftTools.js',
    'sendTools.js',
    'writeResult.js',
    'accountTools.js',
  ]) {
    it(`${file} contains no raw SQL or db.js import`, () => {
      const src = read(file);
      expect(src).not.toMatch(/\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE FROM\b/);
      expect(src).not.toMatch(/from '\.\.\/services\/db\.js'/);
      expect(src).not.toMatch(/\bpool\b/);
    });
  }
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockSurfaceDrift } from '../testSupport/mockSurface.js';

vi.mock('./triageAdapter.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    countUntriagedUnread: vi.fn(async () => 0),
    listTriageCandidates: vi.fn(),
    markTriaged: vi.fn(),
    senderHistory: vi.fn(),
    sentFolderForAccount: vi.fn(async () => null),
    triageActionsForMessages: vi.fn(),
  };
});
vi.mock('./engineAdapter.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    getMessage: vi.fn(),
    getMessageSummariesByIDs: vi.fn(),
    listMessages: vi.fn(),
    resolveAccountScope: vi.fn(),
  };
});
vi.mock('../services/embeddings/hybrid.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    resolveActiveGenerationFromConfig: vi.fn(),
  };
});
vi.mock('../services/embeddings/vectorStore.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    annSearch: vi.fn(),
    loadVector: vi.fn(),
  };
});
vi.mock('../services/mailbox/batch.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    runInBatches: vi.fn(actual.runInBatches),
  };
});
vi.mock('./triageProbes.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    getTriageProbeVectors: vi.fn(),
    scoreTriageProbes: vi.fn(),
  };
});
vi.mock('../utils/mailUtils.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    resolveArchiveFolder: vi.fn(),
    resolveAllTrashPaths: vi.fn(),
    resolveAllSpamPaths: vi.fn(),
  };
});
vi.mock('../services/gtdConfig.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    getGtdFolderSet: vi.fn(),
  };
});
vi.mock('./messageTools.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    findSimilarSummaries: vi.fn(),
  };
});
vi.mock('../services/inboxRules.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    matchingRules: vi.fn(actual.matchingRules),
    toRuleMessage: vi.fn(actual.toRuleMessage),
  };
});

const triageAdapter = await import('./triageAdapter.js');
const engineAdapter = await import('./engineAdapter.js');
const hybrid = await import('../services/embeddings/hybrid.js');
const vectorStore = await import('../services/embeddings/vectorStore.js');
const batch = await import('../services/mailbox/batch.js');
const triageProbes = await import('./triageProbes.js');
const mailUtils = await import('../utils/mailUtils.js');
const gtdConfig = await import('../services/gtdConfig.js');
const messageTools = await import('./messageTools.js');
const inboxRules = await import('../services/inboxRules.js');
const triageTools = await import('./triageTools.js').catch(() => ({}));
const registeredTools = await import('./tools.js').catch(() => ({}));

const MESSAGE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const scope = {
  userId: 'user-1',
  accountIds: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
  scopes: ['read', 'write'],
};
const deps = { ignored: true };
const defaultProbeScores = {
  urgent: 0.2,
  needs_reply: 0.1,
  financial: 0.05,
  scheduling: 0.15,
  bulk: 0.3,
};

function jsonOf(result) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
  engineAdapter.resolveAccountScope.mockImplementation(async (_account, accountIds) => ({
    accountIds,
  }));
  engineAdapter.getMessageSummariesByIDs.mockReset().mockResolvedValue([]);
  triageAdapter.triageActionsForMessages.mockReset().mockResolvedValue([]);
  hybrid.resolveActiveGenerationFromConfig.mockReset().mockResolvedValue({
    cfg: { enabled: true },
    generation: {
      id: 7,
      fingerprint: 'fingerprint-1',
    },
  });
  vectorStore.loadVector.mockReset().mockResolvedValue([1, 0]);
  vectorStore.annSearch.mockReset().mockResolvedValue([]);
  triageProbes.getTriageProbeVectors.mockReset().mockResolvedValue({
    urgent: [1, 0],
  });
  triageProbes.scoreTriageProbes.mockReset().mockReturnValue(defaultProbeScores);
  mailUtils.resolveArchiveFolder.mockReset().mockResolvedValue('Archive');
  mailUtils.resolveAllTrashPaths.mockReset().mockResolvedValue(new Set(['Trash']));
  mailUtils.resolveAllSpamPaths.mockReset().mockResolvedValue(new Set(['Junk']));
  gtdConfig.getGtdFolderSet.mockReset().mockResolvedValue(new Set(['Todo']));
});

describe('mark_triaged definition and registration', () => {
  it('registers an idempotent write tool with the move-ordering warning', () => {
    const def = registeredTools.TOOL_DEFS?.find(entry => entry.name === 'mark_triaged');

    expect(def?.inputSchema.required).toEqual(['message_ids']);
    expect(def?.inputSchema.properties.message_ids).toEqual({
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 500,
    });
    expect(def?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(def?.description).toMatch(/before (?:a )?move\/archive/i);
    expect(def?.description).toMatch(/new_id/);
    expect(def?.description).toMatch(/stale id.*skipped/i);
    expect(registeredTools.TOOL_SCOPES?.mark_triaged).toBe('write');
    expect(registeredTools.HANDLERS?.mark_triaged).toBe(triageTools.handleMarkTriaged);
  });
});

describe('mark_triaged handler', () => {
  it('passes scoped ids and optional receipt metadata to the adapter without inventing tokenId', async () => {
    const receipt = {
      ok: true,
      marked: 1,
      newly_marked: 1,
      already_triaged: 0,
      skipped: [],
    };
    triageAdapter.markTriaged.mockResolvedValue(receipt);

    const result = await triageTools.handleMarkTriaged({
      message_ids: [MESSAGE_ID],
      action: 'archived',
      note: 'Morning pass',
    }, scope, deps);

    expect(result.isError).toBeUndefined();
    expect(jsonOf(result)).toEqual(receipt);
    expect(triageAdapter.markTriaged).toHaveBeenCalledWith({
      userId: scope.userId,
      accountIds: scope.accountIds,
      messageIds: [MESSAGE_ID],
      action: 'archived',
      note: 'Morning pass',
    });
  });

  it('passes through the adapter skip reason for a message without a Message-ID header', async () => {
    const receipt = {
      ok: true,
      marked: 0,
      newly_marked: 0,
      already_triaged: 0,
      skipped: [{ id: MESSAGE_ID, reason: 'no_message_id_header' }],
    };
    triageAdapter.markTriaged.mockResolvedValue(receipt);

    const result = await triageTools.handleMarkTriaged({
      message_ids: [MESSAGE_ID],
    }, scope, deps);

    expect(result.isError).toBeUndefined();
    expect(jsonOf(result)).toEqual(receipt);
  });

  it('passes through an idempotent re-mark receipt under already_triaged', async () => {
    const receipt = {
      ok: true,
      marked: 1,
      newly_marked: 0,
      already_triaged: 1,
      skipped: [],
    };
    triageAdapter.markTriaged.mockResolvedValue(receipt);

    const result = await triageTools.handleMarkTriaged({
      message_ids: [MESSAGE_ID],
      action: 'left',
    }, scope, deps);

    expect(result.isError).toBeUndefined();
    expect(jsonOf(result)).toEqual(receipt);
  });

  it.each([
    [{}, 'message_ids must contain at least one id'],
    [{ message_ids: [] }, 'message_ids must contain at least one id'],
    [{ message_ids: Array.from({ length: 501 }, () => MESSAGE_ID) }, 'Too many ids — maximum 500 per request'],
    [{ message_ids: ['not-a-uuid'] }, 'Invalid message id format'],
    [{ message_ids: [MESSAGE_ID], action: 42 }, 'action must be a string'],
    [{ message_ids: [MESSAGE_ID], note: 42 }, 'note must be a string'],
    [{ message_ids: [MESSAGE_ID], note: 'x'.repeat(501) }, 'note must be at most 500 characters'],
  ])('rejects invalid arguments before checkpointing', async (args, message) => {
    const result = await triageTools.handleMarkTriaged(args, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(message);
    expect(triageAdapter.markTriaged).not.toHaveBeenCalled();
  });
});

const candidateRow = {
  id: MESSAGE_ID,
  account_id: scope.accountIds[0],
  message_id: '<message@example.com>',
  account: 'me@example.com',
  conversation_id: 'thread-1',
  subject: 'Quarterly planning',
  snippet: 'Could you review the agenda?',
  from_email: 'alice@example.com',
  from_name: 'Alice',
  date: new Date('2026-07-28T06:11:00.123Z'),
  is_read: false,
  is_starred: true,
  has_attachments: true,
  category: 'primary',
  is_bulk: false,
  has_unsubscribe: false,
  spam_verdict: null,
  thread_message_count: 3,
  thread_last_activity: new Date('2026-07-28T07:12:00.456Z'),
  i_replied: true,
  contact_known: true,
  send_count: 12,
  last_sent: new Date('2026-07-27T10:00:00.789Z'),
  received_count: 47,
  first_received: new Date('2025-01-01T00:00:00.111Z'),
  last_received: new Date('2026-07-28T06:11:00.123Z'),
};

describe('triage_inbox definition and registration', () => {
  it('registers an idempotent read tool and documents cursor correctness', () => {
    const def = registeredTools.TOOL_DEFS?.find(entry => entry.name === 'triage_inbox');

    expect(def?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(def?.inputSchema.properties).toEqual(expect.objectContaining({
      account: { type: 'string' },
      cursor: { type: 'string' },
      limit: expect.objectContaining({ maximum: 50 }),
      unread_only: expect.objectContaining({ type: 'boolean', default: true }),
      include_triaged: expect.objectContaining({ type: 'boolean', default: false }),
      categories: { type: 'array', items: { type: 'string' } },
      since: { type: 'string' },
      include_signals: expect.objectContaining({ type: 'boolean', default: true }),
    }));
    expect(def?.description).toMatch(/cursor is for paging only/i);
    expect(def?.description).toMatch(/message_triage.*NOT EXISTS/i);
    expect(def?.description).toMatch(/re-running with no cursor is safe and cheap/i);
    expect(def?.description).toMatch(/raw cosine.*not calibrated/i);
    expect(def?.description).toMatch(/rank.*not threshold/i);
    expect(def?.description).toMatch(/fixed.*v1/i);
    expect(registeredTools.TOOL_SCOPES?.triage_inbox).toBe('read');
    expect(registeredTools.HANDLERS?.triage_inbox).toBe(triageTools.handleTriageInbox);
  });
});

describe('triage_inbox handler', () => {
  it('maps one enriched adapter row to the snake_case feed envelope', async () => {
    triageAdapter.listTriageCandidates.mockResolvedValue({
      rows: [candidateRow],
      hasMore: false,
      cursor: 'cursor-one',
    });
    triageAdapter.countUntriagedUnread.mockResolvedValueOnce(118);

    const result = await triageTools.handleTriageInbox({}, scope, deps);

    expect(result.isError).toBeUndefined();
    expect(jsonOf(result)).toEqual({
      items: [{
        id: MESSAGE_ID,
        message_id: '<message@example.com>',
        account: 'me@example.com',
        conversation_id: 'thread-1',
        subject: 'Quarterly planning',
        snippet: 'Could you review the agenda?',
        from_email: 'alice@example.com',
        from_name: 'Alice',
        date: '2026-07-28T06:11:00Z',
        is_read: false,
        is_starred: true,
        has_attachments: true,
        category: 'primary',
        is_bulk: false,
        has_unsubscribe: false,
        spam_verdict: null,
        thread: {
          message_count: 3,
          last_activity: '2026-07-28T07:12:00Z',
          i_replied: true,
        },
        contact: {
          known: true,
          send_count: 12,
          last_sent: '2026-07-27T10:00:00Z',
          received_count: 47,
          first_received: '2025-01-01T00:00:00Z',
          last_received: '2026-07-28T06:11:00Z',
        },
        signals: { similar: [], probes: defaultProbeScores },
      }],
      cursor: 'cursor-one',
      has_more: false,
      counts: { untriaged_unread: 118, returned: 1 },
      signals_available: true,
      signals_reason: null,
      probe_calibration: {
        urgent: { min: 0.2, median: 0.2, max: 0.2 },
        needs_reply: { min: 0.1, median: 0.1, max: 0.1 },
        financial: { min: 0.05, median: 0.05, max: 0.05 },
        scheduling: { min: 0.15, median: 0.15, max: 0.15 },
        bulk: { min: 0.3, median: 0.3, max: 0.3 },
      },
    });
    expect(triageAdapter.listTriageCandidates).toHaveBeenCalledWith({
      accountIds: scope.accountIds,
      cursor: undefined,
      limit: 25,
      unreadOnly: true,
      includeTriaged: false,
      categories: undefined,
      since: undefined,
    });
  });

  it('round-trips the opaque returned cursor into the next adapter call', async () => {
    triageAdapter.listTriageCandidates
      .mockResolvedValueOnce({ rows: [candidateRow], hasMore: true, cursor: 'opaque-page-1' })
      .mockResolvedValueOnce({ rows: [], hasMore: false, cursor: null });

    const first = jsonOf(await triageTools.handleTriageInbox({ include_signals: false }, scope, deps));
    const second = jsonOf(await triageTools.handleTriageInbox({
      cursor: first.cursor,
      include_signals: false,
    }, scope, deps));

    expect(first.cursor).toBe('opaque-page-1');
    expect(second.cursor).toBeNull();
    expect(triageAdapter.listTriageCandidates).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'opaque-page-1' }),
    );
  });

  it('surfaces adapter limit+1 paging as has_more while returning only the page rows', async () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({
      ...candidateRow,
      id: `message-${index}`,
    }));
    triageAdapter.listTriageCandidates.mockResolvedValue({
      rows,
      hasMore: true,
      cursor: 'next-page',
    });

    const body = jsonOf(await triageTools.handleTriageInbox({
      limit: 25,
      include_signals: false,
    }, scope, deps));

    expect(body.items).toHaveLength(25);
    expect(body.counts.returned).toBe(25);
    expect(body.has_more).toBe(true);
    expect(body.cursor).toBe('next-page');
    expect(triageAdapter.listTriageCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25 }),
    );
  });

  it('turns a malformed adapter cursor failure into a clean errorResult', async () => {
    triageAdapter.listTriageCandidates.mockRejectedValue(new Error('invalid triage cursor'));

    const result = await triageTools.handleTriageInbox({ cursor: 'not-a-cursor' }, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('invalid triage cursor');
  });

  it('narrows account scope and threads feed filters with a max-50 limit', async () => {
    engineAdapter.resolveAccountScope.mockResolvedValue({ accountIds: ['account-2'] });
    triageAdapter.listTriageCandidates.mockResolvedValue({
      rows: [],
      hasMore: false,
      cursor: null,
    });

    await triageTools.handleTriageInbox({
      account: 'other@example.com',
      limit: 99,
      unread_only: false,
      include_triaged: true,
      categories: ['newsletter', 'promotion'],
      since: '2026-07-01',
      include_signals: false,
    }, scope, deps);

    expect(engineAdapter.resolveAccountScope).toHaveBeenCalledWith(
      'other@example.com',
      scope.accountIds,
    );
    expect(triageAdapter.listTriageCandidates).toHaveBeenCalledWith({
      accountIds: ['account-2'],
      cursor: undefined,
      limit: 50,
      unreadOnly: false,
      includeTriaged: true,
      categories: ['newsletter', 'promotion'],
      since: '2026-07-01',
    });
  });

  it('reports explicitly disabled signals without attaching per-item placeholders', async () => {
    triageAdapter.listTriageCandidates.mockResolvedValue({
      rows: [candidateRow],
      hasMore: false,
      cursor: null,
    });

    const body = jsonOf(await triageTools.handleTriageInbox({
      include_signals: false,
    }, scope, deps));

    expect(body.signals_available).toBe(false);
    expect(body.signals_reason).toBe('disabled');
    expect(body.items[0]).not.toHaveProperty('signals');
    expect(hybrid.resolveActiveGenerationFromConfig).not.toHaveBeenCalled();
    expect(vectorStore.loadVector).not.toHaveBeenCalled();
  });

  it('silently disables signals above the 25-item cost bound', async () => {
    triageAdapter.listTriageCandidates.mockResolvedValue({
      rows: [candidateRow],
      hasMore: false,
      cursor: null,
    });

    const result = await triageTools.handleTriageInbox({
      limit: 30,
    }, scope, deps);
    const body = jsonOf(result);

    expect(result.isError).toBeUndefined();
    expect(body.signals_available).toBe(false);
    expect(body.signals_reason).toBe('limit_exceeds_25');
    expect(body.items[0].signals).toEqual({ similar: [], probes: {} });
    expect(hybrid.resolveActiveGenerationFromConfig).not.toHaveBeenCalled();
    expect(vectorStore.loadVector).not.toHaveBeenCalled();
  });

  it('computes similar dispositions at concurrency 4 and calibrates page probe scores', async () => {
    const secondCandidate = {
      ...candidateRow,
      id: 'candidate-two',
      message_id: '<two@example.com>',
      date: new Date('2026-07-28T08:00:00.000Z'),
    };
    const rows = [candidateRow, secondCandidate];
    triageAdapter.listTriageCandidates.mockResolvedValue({
      rows,
      hasMore: false,
      cursor: null,
    });
    vectorStore.loadVector.mockImplementation(async id => (
      id === MESSAGE_ID ? [0.2] : [0.8]
    ));
    triageProbes.scoreTriageProbes.mockImplementation(vector => ({
      urgent: vector[0],
      bulk: 1 - vector[0],
    }));
    vectorStore.annSearch.mockImplementation(async (_generationId, _vector, _k, options) => [
      {
        messageId: options.filter.before.getUTCHours() === 6
          ? MESSAGE_ID
          : 'candidate-two',
        score: 1,
      },
      { messageId: 'past-archived', score: 0.9 },
      { messageId: 'past-sent', score: 0.8 },
    ]);
    const hydrated = {
      'past-archived': {
        id: 'past-archived',
        source_id: scope.accountIds[0],
        source_message_id: 'past-archived',
        conversation_id: 'past-thread',
        subject: 'Past archived message',
        sent_at: '2026-06-01T10:00:00.123Z',
        labels: ['Archive', '\\Seen', '\\Flagged'],
      },
      'past-sent': {
        id: 'past-sent',
        source_id: scope.accountIds[0],
        source_message_id: 'past-sent',
        conversation_id: 'past-thread',
        subject: 'My reply',
        sent_at: '2026-06-01T11:00:00.456Z',
        labels: ['Sent'],
      },
    };
    engineAdapter.getMessageSummariesByIDs.mockImplementation(async ids => (
      ids.map(id => hydrated[id]).filter(Boolean)
    ));
    triageAdapter.triageActionsForMessages.mockResolvedValue([{
      account_id: scope.accountIds[0],
      message_id_header: 'past-archived',
      action: 'archived',
      triaged_at: '2026-07-28T08:00:00Z',
    }]);

    const result = await triageTools.handleTriageInbox({}, scope, deps);
    const body = jsonOf(result);

    expect(result.isError).toBeUndefined();
    expect(body.signals_available).toBe(true);
    expect(body.signals_reason).toBeNull();
    expect(body.probe_calibration).toEqual({
      urgent: { min: 0.2, median: 0.5, max: 0.8 },
      bulk: { min: 0.19999999999999996, median: 0.5, max: 0.8 },
    });
    expect(batch.runInBatches).toHaveBeenCalledWith(rows, 4, expect.any(Function));
    expect(vectorStore.annSearch).toHaveBeenCalledWith(
      7,
      [0.2],
      6,
      {
        filter: {
          accountIds: scope.accountIds,
          before: candidateRow.date,
        },
      },
    );
    expect(engineAdapter.getMessageSummariesByIDs).toHaveBeenCalledWith(
      ['past-archived', 'past-sent'],
      scope.accountIds,
    );
    expect(body.items[0].signals.probes).toEqual({ urgent: 0.2, bulk: 0.8 });
    expect(body.items[0].signals.similar[0]).toEqual(expect.objectContaining({
      id: 'past-archived',
      sent_at: '2026-06-01T10:00:00Z',
      score: 0.9,
      disposition: {
        folder_class: 'archived',
        was_read: true,
        was_starred: true,
        was_replied: true,
        triage_action: 'archived',
      },
    }));
    expect(body.items[0].signals.similar[1].disposition).toEqual(expect.objectContaining({
      folder_class: 'sent',
      triage_action: null,
    }));
    expect(triageAdapter.triageActionsForMessages).toHaveBeenCalledTimes(1);
    expect(triageAdapter.triageActionsForMessages).toHaveBeenCalledWith([
      { accountId: scope.accountIds[0], messageIdHeader: 'past-archived' },
      { accountId: scope.accountIds[0], messageIdHeader: 'past-sent' },
    ]);
    expect(mailUtils.resolveArchiveFolder).toHaveBeenCalledTimes(1);
    expect(mailUtils.resolveAllTrashPaths).toHaveBeenCalledTimes(1);
    expect(mailUtils.resolveAllSpamPaths).toHaveBeenCalledTimes(1);
    expect(gtdConfig.getGtdFolderSet).toHaveBeenCalledTimes(1);
    expect(triageAdapter.sentFolderForAccount).toHaveBeenCalledTimes(1);
  });

  it('prefers the resolved sent folder over the name heuristic when one exists', async () => {
    triageAdapter.listTriageCandidates.mockResolvedValue({
      rows: [candidateRow],
      hasMore: false,
      cursor: null,
    });
    triageAdapter.sentFolderForAccount.mockResolvedValue('Custom/Outgoing');
    vectorStore.annSearch.mockResolvedValue([
      { messageId: 'past-outgoing', score: 0.9 },
      { messageId: 'past-sent-items', score: 0.8 },
    ]);
    engineAdapter.getMessageSummariesByIDs.mockResolvedValue([
      {
        id: 'past-outgoing',
        source_id: scope.accountIds[0],
        source_message_id: 'past-outgoing',
        subject: 'Reply from the mapped folder',
        sent_at: '2026-06-01T10:00:00.123Z',
        labels: ['Custom/Outgoing'],
      },
      {
        id: 'past-sent-items',
        source_id: scope.accountIds[0],
        source_message_id: 'past-sent-items',
        subject: 'Name-matches sent but is not the resolved folder',
        sent_at: '2026-06-01T11:00:00.456Z',
        labels: ['Sent Items'],
      },
    ]);

    const result = await triageTools.handleTriageInbox({}, scope, deps);
    const body = jsonOf(result);

    expect(result.isError).toBeUndefined();
    const byId = Object.fromEntries(
      body.items[0].signals.similar.map(entry => [entry.id, entry]),
    );
    expect(byId['past-outgoing'].disposition.folder_class).toBe('sent');
    expect(byId['past-sent-items'].disposition.folder_class).toBe('labelled');
  });

  it('degrades a rejected page triage-action lookup to null dispositions', async () => {
    triageAdapter.listTriageCandidates.mockResolvedValue({
      rows: [candidateRow],
      hasMore: false,
      cursor: null,
    });
    vectorStore.annSearch.mockResolvedValue([
      { messageId: 'past-archived', score: 0.9 },
      { messageId: 'past-sent', score: 0.8 },
    ]);
    engineAdapter.getMessageSummariesByIDs.mockResolvedValue([
      {
        id: 'past-archived',
        source_id: scope.accountIds[0],
        source_message_id: 'past-archived',
        subject: 'Past archived message',
        sent_at: '2026-06-01T10:00:00.123Z',
        labels: ['Archive'],
      },
      {
        id: 'past-sent',
        source_id: scope.accountIds[0],
        source_message_id: 'past-sent',
        subject: 'My reply',
        sent_at: '2026-06-01T11:00:00.456Z',
        labels: ['Sent'],
      },
    ]);
    triageAdapter.triageActionsForMessages.mockRejectedValue(
      new Error('triage lookup unavailable'),
    );

    const result = await triageTools.handleTriageInbox({}, scope, deps);
    const body = jsonOf(result);

    expect(result.isError).toBeUndefined();
    expect(triageAdapter.triageActionsForMessages).toHaveBeenCalledTimes(1);
    expect(body.items[0].signals.similar).toHaveLength(2);
    expect(body.items[0].signals.similar.every(
      similar => similar.disposition.triage_action === null,
    )).toBe(true);
  });

  it('degrades one unembedded candidate without affecting the rest of the page', async () => {
    const missingCandidate = {
      ...candidateRow,
      id: 'missing-vector',
      message_id: '<missing@example.com>',
    };
    triageAdapter.listTriageCandidates.mockResolvedValue({
      rows: [candidateRow, missingCandidate],
      hasMore: false,
      cursor: null,
    });
    vectorStore.loadVector.mockImplementation(async id => {
      if (id === 'missing-vector') throw new Error('no embedding for message');
      return [1, 0];
    });

    const result = await triageTools.handleTriageInbox({}, scope, deps);
    const body = jsonOf(result);

    expect(result.isError).toBeUndefined();
    expect(body.signals_available).toBe(true);
    expect(body.items[0].signals).toEqual({
      similar: [],
      probes: defaultProbeScores,
    });
    expect(body.items[1].signals).toEqual({
      similar: [],
      probes: {},
      reason: 'not_embedded',
    });
  });

  it('turns page-level VectorUnavailableError into empty signals without isError', async () => {
    triageAdapter.listTriageCandidates.mockResolvedValue({
      rows: [candidateRow],
      hasMore: false,
      cursor: null,
    });
    const error = new Error('no active generation');
    error.name = 'VectorUnavailableError';
    error.reason = 'no_active_generation';
    hybrid.resolveActiveGenerationFromConfig.mockRejectedValue(error);

    const result = await triageTools.handleTriageInbox({}, scope, deps);
    const body = jsonOf(result);

    expect(result.isError).toBeUndefined();
    expect(body.signals_available).toBe(false);
    expect(body.signals_reason).toBe(
      'no_active_generation: vector search has no active index yet; wait for the embedding worker to finish an initial build',
    );
    expect(body.items[0].signals).toEqual({ similar: [], probes: {} });
    expect(vectorStore.loadVector).not.toHaveBeenCalled();
  });

  it.each([
    [{ since: '2026-02-30' }, 'invalid since date "2026-02-30": expected YYYY-MM-DD'],
    [{ since: '07/28/2026' }, 'invalid since date "07/28/2026": expected YYYY-MM-DD'],
    [{ categories: 'primary' }, 'categories must be an array of strings'],
    [{ categories: ['primary', 42] }, 'categories must be an array of strings'],
    [{ cursor: 42 }, 'cursor must be a string'],
  ])('rejects malformed filters before reading the feed', async (args, message) => {
    const result = await triageTools.handleTriageInbox(args, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(message);
    expect(triageAdapter.listTriageCandidates).not.toHaveBeenCalled();
  });

  it('returns an unknown-account error without widening scope', async () => {
    engineAdapter.resolveAccountScope.mockResolvedValue({
      error: 'account not found: missing@example.com',
    });

    const result = await triageTools.handleTriageInbox({
      account: 'missing@example.com',
    }, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('account not found: missing@example.com');
    expect(triageAdapter.listTriageCandidates).not.toHaveBeenCalled();
  });
});

const contextSeed = {
  id: MESSAGE_ID,
  account_id: scope.accountIds[0],
  uid: 10,
  folder: 'INBOX',
  message_id: '<message@example.com>',
  thread_id: 'thread-1',
  subject: 'Quarterly planning',
  snippet: 'Could you review the agenda?',
  from_email: 'alice@example.com',
  from_name: 'Alice',
  to_addresses: [{ email: 'me@example.com', name: 'Me' }],
  date: new Date('2026-07-28T06:11:00.123Z'),
  has_attachments: false,
  is_read: false,
};
const threadSummary = {
  id: 'thread-message-1',
  subject: 'Re: Quarterly planning',
  sent_at: '2026-07-28T05:00:00.123Z',
};
const similarSummary = {
  id: 'similar-message-1',
  subject: 'Prior quarterly planning',
  sent_at: '2026-04-01T05:00:00.456Z',
};
const senderHistoryRow = {
  received_count: 8,
  first_received: '2025-01-01T00:00:00Z',
  last_received: '2026-07-28T06:11:00Z',
  contact_id: 'contact-1',
  contact_name: 'Alice',
  primary_email: 'alice@example.com',
  send_count: 3,
  last_sent: '2026-07-20T12:00:00Z',
  is_auto: false,
  contact_known: true,
};
const generation = {
  id: 7,
  model: 'embed-model',
  dimension: 3,
  fingerprint: 'fingerprint-1',
  state: 'active',
};

function contextDeps(rules = []) {
  return { loadInboxRules: vi.fn().mockResolvedValue(rules) };
}

function arrangeContextSuccess() {
  engineAdapter.getMessage.mockResolvedValue(contextSeed);
  engineAdapter.listMessages.mockResolvedValue([threadSummary]);
  triageAdapter.senderHistory.mockResolvedValue(senderHistoryRow);
  messageTools.findSimilarSummaries.mockResolvedValue({
    generation,
    messages: [similarSummary],
  });
}

describe('get_triage_context definition and registration', () => {
  it('registers an idempotent read-only report tool', () => {
    const def = registeredTools.TOOL_DEFS?.find(
      entry => entry.name === 'get_triage_context',
    );

    expect(def?.inputSchema.required).toEqual(['message_id']);
    expect(def?.inputSchema.properties).toEqual({
      message_id: { type: 'string' },
      thread_limit: { type: 'number', minimum: 1, maximum: 50 },
      similar_limit: { type: 'number', minimum: 1, maximum: 50 },
    });
    expect(def?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(def?.description).toMatch(/report only/i);
    expect(def?.description).toMatch(/never executes rule actions/i);
    expect(registeredTools.TOOL_SCOPES?.get_triage_context).toBe('read');
    expect(registeredTools.HANDLERS?.get_triage_context)
      .toBe(triageTools.handleGetTriageContext);
  });
});

describe('get_triage_context handler', () => {
  it('returns thread, sender, similar, and report-only rule sections', async () => {
    arrangeContextSuccess();
    const rules = [
      {
        id: 'rule-subject',
        name: 'Planning',
        condition_logic: 'AND',
        conditions: [{
          field: 'subject',
          operator: 'contains',
          value: 'planning',
        }],
        actions: [{ type: 'star' }],
      },
      {
        id: 'rule-body',
        name: 'Body-only rule',
        condition_logic: 'AND',
        conditions: [{
          field: 'body',
          operator: 'contains',
          value: 'deadline',
        }],
        actions: [{ type: 'archive' }],
      },
      {
        id: 'rule-header',
        name: 'Header-only rule',
        condition_logic: 'AND',
        conditions: [{
          field: 'header',
          headerName: 'List-Id',
          operator: 'contains',
          value: 'newsletter',
        }],
        actions: [{ type: 'mark_read' }],
      },
    ];
    const loaderDeps = contextDeps(rules);

    const result = await triageTools.handleGetTriageContext({
      message_id: MESSAGE_ID,
      thread_limit: 12,
      similar_limit: 6,
    }, scope, loaderDeps);
    const body = jsonOf(result);

    expect(result.isError).toBeUndefined();
    expect(body).toEqual({
      message_id: MESSAGE_ID,
      thread: {
        available: true,
        messages: [{
          ...threadSummary,
          sent_at: '2026-07-28T05:00:00Z',
        }],
      },
      sender_history: {
        available: true,
        history: senderHistoryRow,
      },
      similar: {
        available: true,
        generation,
        messages: [{
          ...similarSummary,
          sent_at: '2026-04-01T05:00:00Z',
        }],
      },
      matched_rules: {
        available: true,
        rules: [
          {
            id: 'rule-subject',
            name: 'Planning',
            would_match: true,
            actions: [{ type: 'star' }],
          },
          {
            id: 'rule-body',
            name: 'Body-only rule',
            evaluated: false,
            reason: 'body_not_loaded',
            actions: [{ type: 'archive' }],
          },
          {
            id: 'rule-header',
            name: 'Header-only rule',
            evaluated: false,
            reason: 'body_not_loaded',
            actions: [{ type: 'mark_read' }],
          },
        ],
      },
    });
    expect(engineAdapter.getMessage).toHaveBeenCalledWith(
      MESSAGE_ID,
      scope.accountIds,
    );
    expect(engineAdapter.listMessages).toHaveBeenCalledWith({
      accountIds: scope.accountIds,
      conversationId: 'thread-1',
      limit: 12,
    });
    expect(triageAdapter.senderHistory).toHaveBeenCalledWith(
      'alice@example.com',
      scope.accountIds,
    );
    expect(messageTools.findSimilarSummaries).toHaveBeenCalledWith(
      MESSAGE_ID,
      { accountIds: scope.accountIds, limit: 6 },
    );
    expect(loaderDeps.loadInboxRules).toHaveBeenCalledWith({
      userId: scope.userId,
      accountId: scope.accountIds[0],
      accountIds: scope.accountIds,
    });
  });

  it.each([
    ['thread', () => engineAdapter.listMessages.mockRejectedValue(new Error('thread down'))],
    ['sender_history', () => triageAdapter.senderHistory.mockRejectedValue(new Error('sender down'))],
    ['similar', () => messageTools.findSimilarSummaries.mockRejectedValue(new Error('similar down'))],
    ['matched_rules', (_deps) => _deps.loadInboxRules.mockRejectedValue(new Error('rules down'))],
  ])('degrades only the %s section and never sets isError', async (failedSection, fail) => {
    arrangeContextSuccess();
    const loaderDeps = contextDeps([]);
    fail(loaderDeps);

    const result = await triageTools.handleGetTriageContext({
      message_id: MESSAGE_ID,
    }, scope, loaderDeps);
    const body = jsonOf(result);

    expect(result.isError).toBeUndefined();
    expect(body[failedSection]).toEqual({
      available: false,
      reason: 'error',
      detail: expect.any(String),
    });
    for (const section of ['thread', 'sender_history', 'similar', 'matched_rules']) {
      if (section !== failedSection) expect(body[section].available).toBe(true);
    }
  });

  it('translates VectorUnavailableError inside similar without failing the tool', async () => {
    arrangeContextSuccess();
    const error = new Error('no active generation');
    error.name = 'VectorUnavailableError';
    error.reason = 'no_active_generation';
    messageTools.findSimilarSummaries.mockRejectedValue(error);

    const result = await triageTools.handleGetTriageContext({
      message_id: MESSAGE_ID,
    }, scope, contextDeps([]));
    const body = jsonOf(result);

    expect(result.isError).toBeUndefined();
    expect(body.similar).toEqual({
      available: false,
      reason: 'no_active_generation: vector search has no active index yet; wait for the embedding worker to finish an initial build',
    });
    expect(body.thread.available).toBe(true);
    expect(body.sender_history.available).toBe(true);
    expect(body.matched_rules.available).toBe(true);
  });

  it('degrades only matched_rules when no read-only loader is importable', async () => {
    arrangeContextSuccess();

    const result = await triageTools.handleGetTriageContext({
      message_id: MESSAGE_ID,
    }, scope, deps);
    const body = jsonOf(result);

    expect(result.isError).toBeUndefined();
    expect(body.matched_rules).toEqual({
      available: false,
      reason: 'rules_loader_unavailable',
    });
    expect(body.thread.available).toBe(true);
    expect(body.sender_history.available).toBe(true);
    expect(body.similar.available).toBe(true);
  });

  it('returns a clean input error before any section work when message_id is absent', async () => {
    const result = await triageTools.handleGetTriageContext({}, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('message_id parameter is required');
    expect(engineAdapter.getMessage).not.toHaveBeenCalled();
  });

  it('returns message not found before starting enrichment sections', async () => {
    engineAdapter.getMessage.mockResolvedValue(null);

    const result = await triageTools.handleGetTriageContext({
      message_id: MESSAGE_ID,
    }, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('message not found');
    expect(engineAdapter.listMessages).not.toHaveBeenCalled();
    expect(triageAdapter.senderHistory).not.toHaveBeenCalled();
    expect(messageTools.findSimilarSummaries).not.toHaveBeenCalled();
  });

  it('degrades all sections without isError when the scoped seed lookup fails', async () => {
    engineAdapter.getMessage.mockRejectedValue(new Error('message store down'));

    const result = await triageTools.handleGetTriageContext({
      message_id: MESSAGE_ID,
    }, scope, deps);
    const body = jsonOf(result);

    expect(result.isError).toBeUndefined();
    for (const section of ['thread', 'sender_history', 'similar', 'matched_rules']) {
      expect(body[section]).toEqual({
        available: false,
        reason: 'seed_lookup_failed',
        detail: 'message store down',
      });
    }
  });
});

describe('mock-drift guard: mocked seams exist on their real modules', () => {
  it.each([
    ['triageAdapter', () => triageAdapter, './triageAdapter.js'],
    ['engineAdapter', () => engineAdapter, './engineAdapter.js'],
    ['messageTools', () => messageTools, './messageTools.js'],
    ['inboxRules', () => inboxRules, '../services/inboxRules.js'],
    ['hybrid', () => hybrid, '../services/embeddings/hybrid.js'],
    ['vectorStore', () => vectorStore, '../services/embeddings/vectorStore.js'],
    ['batch', () => batch, '../services/mailbox/batch.js'],
    ['triageProbes', () => triageProbes, './triageProbes.js'],
    ['mailUtils', () => mailUtils, '../utils/mailUtils.js'],
    ['gtdConfig', () => gtdConfig, '../services/gtdConfig.js'],
  ])('%s mock surface matches the real module', async (_name, getMock, path) => {
    const real = await vi.importActual(path);
    expect(mockSurfaceDrift(getMock(), real)).toEqual([]);
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), parseMailboxList: vi.fn(() => [{ name: 'Hidden', email: 'hidden@example.test' }]), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn((parsed) => parsed), MAX_HEADER_FIELD: 500 }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./spamPipeline.js', () => ({ classifyAndTagMessage: vi.fn() }));
vi.mock('./mailAccess.js', () => ({ getAccountAddresses: vi.fn(async () => []) }));

import { ImapManager, deleteMessageCopyRow } from './imapManager.js';
import { query } from './db.js';
import { pluginRegistry } from '../plugins/registry.js';

function manager() {
  return Object.assign(Object.create(ImapManager.prototype), {
    onDemandSyncing: new Map(), broadcast: vi.fn(),
    syncFolderViaPool: vi.fn().mockResolvedValue(),
  });
}
const account = { id: 'review-fixture-account', user_id: 'fixture-user' };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('on-demand sync completion and deletion counts', () => {
  it('rejects a post-copy wait timeout while preserving its active owner', async () => {
    vi.useFakeTimers();
    const mgr = manager();
    mgr._tryClaimFolderSync(account.id, 'Todo');
    const claim = mgr.onDemandSyncing.get(`${account.id}:Todo`);
    let outcome = 'pending';
    const waiting = mgr.syncFolderOnDemand(account, 'Todo', { freshAfterActive: true })
      .then(() => { outcome = 'fulfilled'; }, () => { outcome = 'rejected'; });
    await vi.advanceTimersByTimeAsync(30000);
    const result = { outcome, postCopyPasses: mgr.syncFolderViaPool.mock.calls.length };
    expect(mgr.onDemandSyncing.get(`${account.id}:Todo`)).toBe(claim);
    mgr._releaseFolderSync(account.id, 'Todo');
    await waiting;
    expect(result).toEqual({ outcome: 'rejected', postCopyPasses: 0 });
  });

  it('propagates the owner sync failure to its waiter', async () => {
    const mgr = manager();
    let fail;
    mgr.syncFolderViaPool.mockReturnValue(new Promise((_, reject) => { fail = reject; }));
    const owner = mgr.syncFolderOnDemand(account, 'Todo');
    const waiter = mgr.syncFolderOnDemand(account, 'Todo');
    const error = new Error('synthetic IMAP FETCH failed');
    fail(error);
    const outcomes = await Promise.allSettled([owner, waiter]);
    expect(outcomes).toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }]);
    expect(mgr.onDemandSyncing.size).toBe(0);
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it.each([false, true])('deletion hooks follow settled count writes even on failure (%s), without awaiting plugins', async fails => {
    let finishCount;
    let countState = 'pending';
    query.mockReset().mockImplementation(sql => {
      if (sql.includes('DELETE FROM messages')) return Promise.resolve({ rows: [{ is_read: false, thread_key: 'fixture-thread' }] });
      return new Promise((resolve, reject) => { finishCount = () => {
        countState = fails ? 'failed' : 'complete';
        if (fails) reject(new Error('count write failed'));
        else resolve({ rows: [] });
      }; });
    });
    const observed = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(pluginRegistry, 'runHook').mockImplementation(name => {
      if (name === 'messageRowsDeleted') observed.push(countState);
      return new Promise(() => {});
    });
    const deletion = deleteMessageCopyRow(account.id, 7, 'Todo', account);
    await vi.waitFor(() => expect(finishCount).toBeTypeOf('function'));
    try { expect(observed).toEqual([]); }
    finally { finishCount(); await deletion; }
    expect(observed).toEqual([fails ? 'failed' : 'complete']);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/db.js', () => ({ query: vi.fn() }));
vi.mock('./gtdConfig.js', () => ({
  getGtdFolderSet: vi.fn(), getGtdConfig: vi.fn(),
  sanitizeGtdFoldersDetailed: vi.fn(), findGtdFolderCollisions: vi.fn(),
  DEFAULT_GTD_FOLDERS: { todo: 'Todo', watch: 'Watch', delegated: 'Delegated', someday: 'Someday', reference: 'Reference' },
  invalidateGtdConfigCache: vi.fn(),
}));
vi.mock('./gtdTransitions.js', () => ({ runGtdTransitions: vi.fn(), threadKeysForMessageIds: vi.fn(), threadKeysInFolders: vi.fn(), runTransitionsForSentMessage: vi.fn(), invalidateOwnerAddressesCache: vi.fn() }));
vi.mock('./gtdSections.js', () => ({ emitGtdIfRelevant: vi.fn() }));
vi.mock('./gtdPet.js', () => ({ deleteUserPet: vi.fn() }));
// Per-account plugin config store (backs enrichAccount / persistAccountSettings and the effective
// gate inside getGtdConfig). Mocked at the source module so the api.js barrel re-export resolves to
// these fns too.
vi.mock('../accountConfig.js', () => ({ getAccountConfig: vi.fn(), setAccountConfig: vi.fn() }));
import { query } from '../../services/db.js';
import { getGtdFolderSet, getGtdConfig, sanitizeGtdFoldersDetailed, findGtdFolderCollisions, invalidateGtdConfigCache } from './gtdConfig.js';
import { getAccountConfig, setAccountConfig } from '../accountConfig.js';
import { runGtdTransitions, threadKeysForMessageIds, runTransitionsForSentMessage, invalidateOwnerAddressesCache } from './gtdTransitions.js';
import { emitGtdIfRelevant } from './gtdSections.js';
import { deleteUserPet } from './gtdPet.js';
import { relocateExemptFolders, sectionsChanged, inboxIngest, selectGtdReevalIds, gtdEnabledForAccount, emitAfterDeferredCopySync, afterLabelCopy, afterLabelRemove, messageRowsIngested, onMailMutation, onSentMessage, onUserDelete, enrichAccount, validateAccountSettings, persistAccountSettings, onAccountIdentityChanged, onPluginActivationChanged } from './hooks.js';

describe('gtd hooks — relocateExemptFolders', () => {
  beforeEach(() => getGtdFolderSet.mockReset());

  it('returns the account\'s designated GTD folders as a plain array', async () => {
    getGtdFolderSet.mockResolvedValueOnce(new Set(['Todo', 'Watch', 'Delegated']));
    const folders = await relocateExemptFolders({ accountId: 'a1' });
    expect(getGtdFolderSet).toHaveBeenCalledWith('a1');
    expect(folders).toEqual(['Todo', 'Watch', 'Delegated']);
  });

  it('contributes nothing when GTD is disabled (empty set)', async () => {
    getGtdFolderSet.mockResolvedValueOnce(new Set());
    expect(await relocateExemptFolders({ accountId: 'a1' })).toEqual([]);
  });
});

describe('gtd hooks — sectionsChanged', () => {
  beforeEach(() => getGtdConfig.mockReset());
  const mgr = () => ({ broadcast: vi.fn() });
  const account = { id: 'a1', user_id: 'u1' };

  it('broadcasts gtd_sections_updated once when GTD is enabled and rows changed', async () => {
    getGtdConfig.mockResolvedValueOnce({ enabled: true });
    const imap = mgr();
    await sectionsChanged({ mgr: imap, account, changedCount: 4 });
    expect(imap.broadcast).toHaveBeenCalledTimes(1);
    expect(imap.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: 'a1' }, 'u1');
  });

  it('does not broadcast when GTD is disabled for the account', async () => {
    getGtdConfig.mockResolvedValueOnce({ enabled: false });
    const imap = mgr();
    await sectionsChanged({ mgr: imap, account, changedCount: 4 });
    expect(imap.broadcast).not.toHaveBeenCalled();
  });

  it('does not read config or broadcast when changedCount is not > 0', async () => {
    const imap = mgr();
    await sectionsChanged({ mgr: imap, account, changedCount: 0 });
    expect(getGtdConfig).not.toHaveBeenCalled();
    expect(imap.broadcast).not.toHaveBeenCalled();
  });

  it('swallows a config-lookup failure without broadcasting or throwing', async () => {
    getGtdConfig.mockRejectedValueOnce(new Error('db boom'));
    const imap = mgr();
    await expect(sectionsChanged({ mgr: imap, account, changedCount: 2 })).resolves.toBeUndefined();
    expect(imap.broadcast).not.toHaveBeenCalled();
  });
});

describe('gtd hooks — selectGtdReevalIds', () => {
  it('includes an already-read is_new arrival (read state is not a gate)', () => {
    expect(selectGtdReevalIds(['read-reply'], [])).toEqual(['read-reply']);
  });

  it('excludes a genuinely-deleted candidate but keeps a rule-MOVED one', () => {
    expect(selectGtdReevalIds(['deleted', 'moved', 'stayed'], ['deleted'])).toEqual(['moved', 'stayed']);
  });

  it('accepts the deleted ids as a Set and returns [] when all candidates were deleted', () => {
    expect(selectGtdReevalIds(['a', 'b'], new Set(['a', 'b']))).toEqual([]);
  });

  it('returns [] for an empty candidate list', () => {
    expect(selectGtdReevalIds([], ['x'])).toEqual([]);
  });
});

describe('gtd hooks — inboxIngest', () => {
  beforeEach(() => { runGtdTransitions.mockReset(); threadKeysForMessageIds.mockReset(); });
  const account = { id: 'a1', user_id: 'u1' };

  it('resolves candidate ids to thread keys and runs transitions over them', async () => {
    threadKeysForMessageIds.mockResolvedValueOnce(['thr-1', 'thr-2']);
    const mgr = {};
    await inboxIngest({ mgr, account, newInboxIds: ['m1', 'm2'], deletedIds: new Set() });
    expect(threadKeysForMessageIds).toHaveBeenCalledWith('a1', ['m1', 'm2']);
    expect(runGtdTransitions).toHaveBeenCalledWith(mgr, account, ['thr-1', 'thr-2']);
  });

  it('drops rule-deleted candidates before resolving threads', async () => {
    threadKeysForMessageIds.mockResolvedValueOnce(['thr-moved']);
    await inboxIngest({ mgr: {}, account, newInboxIds: ['deleted', 'moved'], deletedIds: new Set(['deleted']) });
    expect(threadKeysForMessageIds).toHaveBeenCalledWith('a1', ['moved']);
  });

  it('does no work when every candidate was deleted', async () => {
    await inboxIngest({ mgr: {}, account, newInboxIds: ['x'], deletedIds: new Set(['x']) });
    expect(threadKeysForMessageIds).not.toHaveBeenCalled();
    expect(runGtdTransitions).not.toHaveBeenCalled();
  });

  it('swallows a transition failure without throwing into core', async () => {
    threadKeysForMessageIds.mockRejectedValueOnce(new Error('db boom'));
    await expect(inboxIngest({ mgr: {}, account, newInboxIds: ['m1'], deletedIds: new Set() }))
      .resolves.toBeUndefined();
    expect(runGtdTransitions).not.toHaveBeenCalled();
  });

  it('gtdEnabledForAccount reflects the account\'s effective GTD config', async () => {
    getGtdConfig.mockResolvedValueOnce({ enabled: true });
    expect(await gtdEnabledForAccount({ account: { id: 'a1' } })).toBe(true);
    getGtdConfig.mockResolvedValueOnce({ enabled: false });
    expect(await gtdEnabledForAccount({ account: { id: 'a1' } })).toBe(false);
    // No account id → false without a config read.
    expect(await gtdEnabledForAccount({})).toBe(false);
    expect(await gtdEnabledForAccount(undefined)).toBe(false);
  });
});

describe('gtd hooks — emitAfterDeferredCopySync', () => {
  beforeEach(() => {
    query.mockReset(); runGtdTransitions.mockReset();
    getGtdConfig.mockReset(); getGtdConfig.mockResolvedValue({ enabled: false }); // GTD off unless a test enables it
  });

  it('re-emits gtd_sections_updated after the deferred destination sync resolves', async () => {
    const mgr = { syncFolderOnDemand: vi.fn().mockResolvedValue(undefined), broadcast: vi.fn() };
    const account = { id: 'acct-1', user_id: 'user-1' }; // gtd_enabled falsy → no transition re-run
    await emitAfterDeferredCopySync(mgr, account, 'Todo', 100, 'INBOX');
    expect(mgr.syncFolderOnDemand).toHaveBeenCalledWith(account, 'Todo');
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: 'acct-1' }, 'user-1');
    expect(runGtdTransitions).not.toHaveBeenCalled();
  });

  it('does not emit when the deferred sync fails', async () => {
    const mgr = { syncFolderOnDemand: vi.fn().mockRejectedValue(new Error('sync boom')), broadcast: vi.fn() };
    const account = { id: 'acct-1', user_id: 'user-1' };
    await emitAfterDeferredCopySync(mgr, account, 'Todo', 100, 'INBOX');
    expect(mgr.broadcast).not.toHaveBeenCalled();
    expect(runGtdTransitions).not.toHaveBeenCalled();
  });

  it('re-runs the transition engine over the copied message thread once the sibling syncs', async () => {
    const mgr = { syncFolderOnDemand: vi.fn().mockResolvedValue(undefined), broadcast: vi.fn() };
    const account = { id: 'acct-1', user_id: 'user-1' };
    getGtdConfig.mockResolvedValue({ enabled: true });
    query.mockResolvedValueOnce({ rows: [{ thread_key: 'thr-9' }] });
    await emitAfterDeferredCopySync(mgr, account, 'Todo', 100, 'INBOX');
    expect(query.mock.calls[0][1]).toEqual(['acct-1', 100, 'INBOX']);
    expect(runGtdTransitions).toHaveBeenCalledWith(mgr, account, ['thr-9']);
  });

  it('swallows a transition re-run failure after still emitting', async () => {
    const mgr = { syncFolderOnDemand: vi.fn().mockResolvedValue(undefined), broadcast: vi.fn() };
    const account = { id: 'acct-1', user_id: 'user-1' };
    getGtdConfig.mockResolvedValue({ enabled: true });
    query.mockRejectedValueOnce(new Error('db boom'));
    await emitAfterDeferredCopySync(mgr, account, 'Todo', 100, 'INBOX');
    expect(mgr.broadcast).toHaveBeenCalled();
    expect(runGtdTransitions).not.toHaveBeenCalled();
  });
});

describe('gtd hooks — afterLabelCopy / afterLabelRemove', () => {
  beforeEach(() => { query.mockReset(); runGtdTransitions.mockReset(); });

  it('afterLabelCopy broadcasts and, on the UIDPLUS path (newUid set), does no deferred sync', async () => {
    const mgr = { broadcast: vi.fn(), syncFolderOnDemand: vi.fn() };
    const account = { id: 'a1', user_id: 'u1' };
    await afterLabelCopy({ mgr, account, toFolder: 'Todo', fromFolder: 'INBOX', srcUid: 5, newUid: 42 });
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: 'a1' }, 'u1');
    expect(mgr.syncFolderOnDemand).not.toHaveBeenCalled();
  });

  it('afterLabelCopy kicks off the deferred reconcile on the non-UIDPLUS path (newUid null)', async () => {
    const mgr = { broadcast: vi.fn(), syncFolderOnDemand: vi.fn().mockResolvedValue(undefined) };
    const account = { id: 'a1', user_id: 'u1' };
    await afterLabelCopy({ mgr, account, toFolder: 'Todo', fromFolder: 'INBOX', srcUid: 5, newUid: null });
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: 'a1' }, 'u1');
    expect(mgr.syncFolderOnDemand).toHaveBeenCalledWith(account, 'Todo');
  });

  it('afterLabelRemove broadcasts the section refresh', async () => {
    const mgr = { broadcast: vi.fn() };
    await afterLabelRemove({ mgr, account: { id: 'a1', user_id: 'u1' } });
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: 'a1' }, 'u1');
  });

  it('clears delegation only after the final Delegated copy disappears', async () => {
    getGtdConfig.mockResolvedValue({ enabled: true, folders: { delegated: 'Delegated' } });
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 3, rows: [] });
    const mgr = { broadcast: vi.fn() };
    await afterLabelRemove({
      mgr,
      account: { id: 'a1', user_id: 'u1' },
      folder: 'Delegated',
      threadKey: 'thread-1',
    });
    expect(query.mock.calls[0][1]).toEqual(['a1', 'thread-1', 'Delegated']);
    expect(query.mock.calls[1][0]).toContain('(plugin_annotations -> $3) - $4');
  });

  it('retains delegation while a Delegated copy survives', async () => {
    getGtdConfig.mockResolvedValue({ enabled: true, folders: { delegated: 'Delegated' } });
    query.mockResolvedValueOnce({ rows: [{ uid: 91 }] });
    await afterLabelRemove({
      mgr: { broadcast: vi.fn() },
      account: { id: 'a1', user_id: 'u1' },
      folder: 'Delegated',
      threadKey: 'thread-1',
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('gtd hooks — delegation inheritance', () => {
  beforeEach(() => query.mockReset());

  it('copies an authoritative thread delegation onto newly ingested rows', async () => {
    const delegation = { contactId: 'c1', displayName: 'Casey' };
    query
      .mockResolvedValueOnce({ rows: [{ thread_key: 'thread-1' }] })
      .mockResolvedValueOnce({ rows: [
        { id: 'new-row', thread_key: 'thread-1', plugin_annotations: {} },
        { id: 'old-row', thread_key: 'thread-1', plugin_annotations: { gtd: { delegation } } },
      ] })
      .mockResolvedValueOnce({ rowCount: 2, rows: [] });

    await messageRowsIngested({ account: { id: 'a1' }, messageIds: ['new-row'] });

    expect(query.mock.calls[2][1]).toEqual(['a1', 'thread-1', 'gtd', 'delegation', JSON.stringify(delegation)]);
  });
});

describe('gtd hooks — route-layer adapters (onMailMutation / onSentMessage / onUserDelete)', () => {
  beforeEach(() => { emitGtdIfRelevant.mockReset(); runTransitionsForSentMessage.mockReset(); deleteUserPet.mockReset(); query.mockReset(); });

  it('onMailMutation delegates to emitGtdIfRelevant with the mutation context', async () => {
    emitGtdIfRelevant.mockResolvedValueOnce(undefined);
    const mgr = {};
    await onMailMutation({ imapManager: mgr, accountId: 'a1', userId: 'u1', messageIds: ['<m1>'], actedFolders: ['INBOX'] });
    expect(emitGtdIfRelevant).toHaveBeenCalledWith(mgr, 'a1', 'u1', ['<m1>'], ['INBOX']);
  });

  it('onSentMessage delegates to runTransitionsForSentMessage', async () => {
    runTransitionsForSentMessage.mockResolvedValueOnce(undefined);
    const mgr = {};
    const account = { id: 'a1', gtd_enabled: true };
    await onSentMessage({ imapManager: mgr, account, messageId: '<abc@x>' });
    expect(runTransitionsForSentMessage).toHaveBeenCalledWith(mgr, account, '<abc@x>');
  });

  it('onUserDelete removes the user\'s pet through the plugin storage capability', async () => {
    deleteUserPet.mockResolvedValueOnce(undefined);
    await onUserDelete({ userId: 'user-1' });
    expect(deleteUserPet).toHaveBeenCalledWith('user-1');
  });

  it('onUserDelete swallows a pet-cleanup failure without throwing', async () => {
    deleteUserPet.mockRejectedValueOnce(new Error('storage boom'));
    await expect(onUserDelete({ userId: 'user-3' })).resolves.toBeUndefined();
  });
});

describe('gtd hooks — account settings (enrichAccount / validateAccountSettings / persistAccountSettings / onAccountIdentityChanged)', () => {
  beforeEach(() => {
    sanitizeGtdFoldersDetailed.mockReset(); findGtdFolderCollisions.mockReset();
    invalidateGtdConfigCache.mockReset(); invalidateOwnerAddressesCache.mockReset();
    getAccountConfig.mockReset(); getAccountConfig.mockResolvedValue({ enabled: false, folders: {} });
    setAccountConfig.mockReset();
  });

  it('enrichAccount attaches gtd_enabled/gtd_folders from the config store', async () => {
    getAccountConfig.mockResolvedValueOnce({ enabled: true, folders: { todo: 'Tasks' } });
    const out = await enrichAccount({ account: { id: 'a1' } });
    expect(getAccountConfig).toHaveBeenCalledWith('gtd', 'a1');
    expect(out).toEqual({ gtd_enabled: true, gtd_folders: { todo: 'Tasks' } });
  });

  it('enrichAccount defaults to disabled + empty folders when no config is stored', async () => {
    getAccountConfig.mockResolvedValueOnce({});
    expect(await enrichAccount({ account: { id: 'a1' } })).toEqual({ gtd_enabled: false, gtd_folders: {} });
  });

  it('validateAccountSettings contributes nothing when neither gtd field is being updated', async () => {
    expect(await validateAccountSettings({ updates: { color: '#fff' }, accountId: 'a1' })).toBeUndefined();
    expect(sanitizeGtdFoldersDetailed).not.toHaveBeenCalled();
  });

  it('flags a reconnect for a gtd_enabled toggle even without a folder change', async () => {
    const out = await validateAccountSettings({ updates: { gtd_enabled: true }, accountId: 'a1' });
    expect(out).toEqual({ requiresReconnect: true });
    expect(sanitizeGtdFoldersDetailed).not.toHaveBeenCalled();
  });

  it('hard-rejects a state mapped to a reserved system folder', async () => {
    sanitizeGtdFoldersDetailed.mockReturnValueOnce({ folders: {}, rejected: [], reserved: ['INBOX'] });
    const out = await validateAccountSettings({ updates: { gtd_folders: { todo: 'INBOX' } }, accountId: 'a1' });
    expect(out.error.status).toBe(400);
    expect(out.error.body.reserved).toEqual(['INBOX']);
  });

  it('hard-rejects a folder collision', async () => {
    sanitizeGtdFoldersDetailed.mockReturnValueOnce({ folders: { todo: 'X', watch: 'X' }, rejected: [], reserved: [] });
    findGtdFolderCollisions.mockReturnValueOnce(['X']);
    const out = await validateAccountSettings({ updates: { gtd_folders: { todo: 'X', watch: 'X' } }, accountId: 'a1' });
    expect(out.error.status).toBe(400);
    expect(out.error.body.collisions).toEqual(['X']);
  });

  it('reports rejections and reconnects on a real folder change (against the stored config)', async () => {
    // stored config folders differ from the new ones → requiresReconnect
    getAccountConfig.mockResolvedValueOnce({ enabled: true, folders: {} });
    sanitizeGtdFoldersDetailed
      .mockReturnValueOnce({ folders: { todo: 'Tasks' }, rejected: ['bad/../path'], reserved: [] }) // new
      .mockReturnValueOnce({ folders: { todo: 'Todo' } });                                            // stored
    findGtdFolderCollisions.mockReturnValueOnce([]);
    const out = await validateAccountSettings({ updates: { gtd_folders: { todo: 'Tasks' } }, accountId: 'a1' });
    expect(out.patch).toBeUndefined();                       // validate no longer writes
    expect(out.rejected).toEqual({ gtd_folders: ['bad/../path'] });
    expect(out.requiresReconnect).toBe(true);
  });

  it('does not require a reconnect when the sanitized folders match the stored config', async () => {
    getAccountConfig.mockResolvedValueOnce({ enabled: true, folders: {} });
    sanitizeGtdFoldersDetailed
      .mockReturnValueOnce({ folders: { todo: 'Todo' }, rejected: [], reserved: [] }) // new
      .mockReturnValueOnce({ folders: { todo: 'Todo' } });                            // stored
    findGtdFolderCollisions.mockReturnValueOnce([]);
    const out = await validateAccountSettings({ updates: { gtd_folders: { todo: 'Todo' } }, accountId: 'a1' });
    expect(out.requiresReconnect).toBe(false);
  });

  it('persistAccountSettings writes gtd_enabled into the config store, preserving stored folders', async () => {
    getAccountConfig.mockResolvedValueOnce({ enabled: false, folders: { todo: 'Tasks' } });
    const out = await persistAccountSettings({ accountId: 'a1', updates: { gtd_enabled: true } });
    expect(setAccountConfig).toHaveBeenCalledWith('gtd', 'a1', { enabled: true, folders: { todo: 'Tasks' } });
    expect(out).toEqual({ patch: { gtd_enabled: true, gtd_folders: { todo: 'Tasks' } } });
    expect(invalidateGtdConfigCache).toHaveBeenCalledWith('a1');
  });

  it('persistAccountSettings writes sanitized folders, preserving the stored enabled flag', async () => {
    getAccountConfig.mockResolvedValueOnce({ enabled: true, folders: {} });
    sanitizeGtdFoldersDetailed.mockReturnValueOnce({ folders: { todo: 'Tasks' }, rejected: [], reserved: [] });
    const out = await persistAccountSettings({ accountId: 'a1', updates: { gtd_folders: { todo: 'Tasks' } } });
    expect(setAccountConfig).toHaveBeenCalledWith('gtd', 'a1', { enabled: true, folders: { todo: 'Tasks' } });
    expect(out.patch).toEqual({ gtd_enabled: true, gtd_folders: { todo: 'Tasks' } });
  });

  it('persistAccountSettings contributes nothing (no write) when no gtd field changed', async () => {
    expect(await persistAccountSettings({ accountId: 'a1', updates: { color: '#fff' } })).toBeUndefined();
    expect(setAccountConfig).not.toHaveBeenCalled();
  });

  it('onAccountIdentityChanged invalidates the owner-address cache', async () => {
    await onAccountIdentityChanged({ accountId: 'a1' });
    expect(invalidateOwnerAddressesCache).toHaveBeenCalledWith('a1');
  });
});

describe('gtd hooks — onPluginActivationChanged', () => {
  beforeEach(() => { query.mockReset(); invalidateGtdConfigCache.mockReset(); });

  it('invalidates GTD config cache for all the user\'s accounts when gtd is toggled', async () => {
    // onPluginActivationChanged lists the user's accounts via the listUserAccounts capability
    // (user-scoped query) and invalidates GTD's config cache for each.
    query.mockResolvedValueOnce({ rows: [{ id: 'a1' }, { id: 'a2' }] });
    await onPluginActivationChanged({ userId: 'u1', pluginId: 'gtd', activated: false });
    expect(query.mock.calls[0][1]).toEqual(['u1']);
    expect(invalidateGtdConfigCache).toHaveBeenCalledWith('a1');
    expect(invalidateGtdConfigCache).toHaveBeenCalledWith('a2');
  });

  it('ignores a non-gtd plugin (no query, no invalidation)', async () => {
    await onPluginActivationChanged({ userId: 'u1', pluginId: 'other', activated: true });
    expect(query).not.toHaveBeenCalled();
    expect(invalidateGtdConfigCache).not.toHaveBeenCalled();
  });
});

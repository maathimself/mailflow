import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({
  resolveArchiveFolder: vi.fn(),
  resolveTrashFolder: vi.fn(),
  resolveAllTrashPaths: vi.fn(),
  getDeleteStrategy: vi.fn(),
}));

const { query } = await import('./db.js');
const { resolveArchiveFolder } = await import('../utils/mailUtils.js');
import { applyInboxRules } from './inboxRules.js';

const account = { id: 'acc-1', user_id: 'user-1', folder_mappings: {} };

const mkMsg = (overrides = {}) => ({
  id: 'msg-1', uid: 100, folder: 'INBOX', account_id: 'acc-1',
  fromEmail: 'sender@example.com', fromName: 'Sender',
  to: [], subject: 'Test', is_read: false, hasAttachments: false,
  parsedHeaders: {},
  ...overrides,
});

const mkRule = (actions, overrides = {}) => ({
  id: 'rule-1', user_id: 'user-1', account_id: null, enabled: true,
  stop_processing: false, condition_logic: 'AND',
  conditions: [{ field: 'from', operator: 'contains', value: 'sender@' }],
  actions,
  ...overrides,
});

const mockImap = {
  bulkMoveMessages: vi.fn(),
  setFlag: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('applyInboxRules — destination action no-ops do not remove message', () => {
  it('leaves message in inbox when move action has a blank destination', async () => {
    const rule = mkRule([{ type: 'move', value: '' }]);
    query.mockResolvedValueOnce({ rows: [rule] });

    const result = await applyInboxRules([mkMsg()], account, mockImap);

    expect(result).toHaveLength(1);
    expect(mockImap.bulkMoveMessages).not.toHaveBeenCalled();
  });

  it('leaves message in inbox when archive folder is not configured', async () => {
    const rule = mkRule([{ type: 'archive', value: '' }]);
    query.mockResolvedValueOnce({ rows: [rule] });
    resolveArchiveFolder.mockResolvedValue(null);

    const result = await applyInboxRules([mkMsg()], account, mockImap);

    expect(result).toHaveLength(1);
    expect(mockImap.bulkMoveMessages).not.toHaveBeenCalled();
  });
});

describe('applyInboxRules — destination action deduplication', () => {
  it('executes only the first destination action when a legacy rule has move + archive', async () => {
    const rule = mkRule([
      { type: 'move', value: 'INBOX/Work' },
      { type: 'archive', value: '' },
    ]);
    query
      .mockResolvedValueOnce({ rows: [rule] })  // getRulesForAccount
      .mockResolvedValueOnce({ rows: [] });       // UPDATE folder (move)
    // resolveArchiveFolder returns a valid path — if archive action ran it would
    // cause a second bulkMoveMessages call, making the assertion below fail
    resolveArchiveFolder.mockResolvedValue('Archive');
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [] });

    await applyInboxRules([mkMsg()], account, mockImap);

    expect(mockImap.bulkMoveMessages).toHaveBeenCalledOnce();
    expect(mockImap.bulkMoveMessages).toHaveBeenCalledWith(account, [100], 'INBOX', 'INBOX/Work');
  });

  it('executes only the first destination action when a legacy rule has move + delete', async () => {
    const rule = mkRule([
      { type: 'move', value: 'INBOX/Archive' },
      { type: 'delete', value: '' },
    ]);
    query
      .mockResolvedValueOnce({ rows: [rule] })
      .mockResolvedValueOnce({ rows: [] });
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [] });

    await applyInboxRules([mkMsg()], account, mockImap);

    expect(mockImap.bulkMoveMessages).toHaveBeenCalledOnce();
    expect(mockImap.bulkMoveMessages).toHaveBeenCalledWith(account, [100], 'INBOX', 'INBOX/Archive');
  });

  it('skips subsequent destination actions even when the first one fails', async () => {
    // If move fails due to a bad path, archive must not run as a silent fallback.
    const rule = mkRule([
      { type: 'move', value: 'INBOX/NonExistent' },
      { type: 'archive', value: '' },
    ]);
    query.mockResolvedValueOnce({ rows: [rule] });
    resolveArchiveFolder.mockResolvedValue('Archive');
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [100] }); // move fails

    await applyInboxRules([mkMsg()], account, mockImap);

    // move was attempted once and failed; archive must not have been attempted
    expect(mockImap.bulkMoveMessages).toHaveBeenCalledOnce();
    expect(resolveArchiveFolder).not.toHaveBeenCalled();
  });

  it('still executes non-destination actions alongside a destination action', async () => {
    const rule = mkRule([
      { type: 'mark_read', value: '' },
      { type: 'move', value: 'INBOX/Work' },
    ]);
    query
      .mockResolvedValueOnce({ rows: [rule] })  // getRulesForAccount
      .mockResolvedValueOnce({ rows: [] })        // UPDATE is_read (mark_read)
      .mockResolvedValueOnce({ rows: [] });        // UPDATE folder (move)
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [] });
    mockImap.setFlag.mockResolvedValue(undefined);

    await applyInboxRules([mkMsg()], account, mockImap);

    expect(mockImap.bulkMoveMessages).toHaveBeenCalledOnce();
    expect(mockImap.setFlag).toHaveBeenCalledWith(account, 100, 'INBOX', '\\Seen', true);
  });
});

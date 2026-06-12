import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({
  resolveArchiveFolder: vi.fn(),
  resolveTrashFolder: vi.fn(),
  resolveAllTrashPaths: vi.fn(),
  getDeleteStrategy: vi.fn(),
  adjustFolderCounts: vi.fn(),
}));

const { query } = await import('./db.js');
const { resolveArchiveFolder, adjustFolderCounts } = await import('../utils/mailUtils.js');
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
  _guardMoveUid: vi.fn(),
  _unguardMoveUid: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('applyInboxRules — blank condition value never matches', () => {
  it('does not fire a move rule when the condition value is an empty string', async () => {
    const rule = mkRule(
      [{ type: 'move', value: 'INBOX/Work' }],
      { conditions: [{ field: 'from', operator: 'contains', value: '' }] }
    );
    query.mockResolvedValueOnce({ rows: [rule] });

    const result = await applyInboxRules([mkMsg()], account, mockImap);

    expect(result.remaining).toHaveLength(1); // message stays in inbox
    expect(mockImap.bulkMoveMessages).not.toHaveBeenCalled();
  });

  it('does not fire a delete rule when the subject condition value is whitespace', async () => {
    const rule = mkRule(
      [{ type: 'delete', value: '' }],
      { conditions: [{ field: 'subject', operator: 'starts_with', value: '   ' }] }
    );
    query.mockResolvedValueOnce({ rows: [rule] });

    const result = await applyInboxRules([mkMsg()], account, mockImap);

    expect(result.remaining).toHaveLength(1);
    expect(mockImap.bulkMoveMessages).not.toHaveBeenCalled();
  });
});

describe('applyInboxRules — malformed condition does not abort other rules', () => {
  it('skips the malformed rule and still applies a subsequent valid rule', async () => {
    const badRule = {
      ...mkRule([{ type: 'mark_read', value: '' }], { id: 'rule-bad' }),
      conditions: [null], // null condition would throw in evaluateCondition
    };
    const goodRule = mkRule(
      [{ type: 'move', value: 'INBOX/Work' }],
      { id: 'rule-good', stop_processing: false }
    );
    query
      .mockResolvedValueOnce({ rows: [badRule, goodRule] })  // getRulesForAccount
      .mockResolvedValueOnce({ rows: [] });                    // UPDATE folder (move)
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [], uidMap: new Map() });

    const result = await applyInboxRules([mkMsg()], account, mockImap);

    // good rule fired, message removed from inbox
    expect(result.remaining).toHaveLength(0);
    expect(mockImap.bulkMoveMessages).toHaveBeenCalledOnce();
  });
});

describe('applyInboxRules — destination action no-ops do not remove message', () => {
  it('leaves message in inbox when move action has a blank destination', async () => {
    const rule = mkRule([{ type: 'move', value: '' }]);
    query.mockResolvedValueOnce({ rows: [rule] });

    const result = await applyInboxRules([mkMsg()], account, mockImap);

    expect(result.remaining).toHaveLength(1);
    expect(mockImap.bulkMoveMessages).not.toHaveBeenCalled();
  });

  it('leaves message in inbox when archive folder is not configured', async () => {
    const rule = mkRule([{ type: 'archive', value: '' }]);
    query.mockResolvedValueOnce({ rows: [rule] });
    resolveArchiveFolder.mockResolvedValue(null);

    const result = await applyInboxRules([mkMsg()], account, mockImap);

    expect(result.remaining).toHaveLength(1);
    expect(mockImap.bulkMoveMessages).not.toHaveBeenCalled();
  });
});

describe('applyInboxRules — UID update after move', () => {
  it('updates both folder and uid when uidMap contains the new uid', async () => {
    const rule = mkRule([{ type: 'move', value: 'INBOX/Work' }]);
    query
      .mockResolvedValueOnce({ rows: [rule] })  // getRulesForAccount
      .mockResolvedValueOnce({ rows: [] });       // UPDATE folder+uid (move)
    mockImap.bulkMoveMessages.mockResolvedValue({
      failed: [],
      uidMap: new Map([[100, 789]]),
    });

    const result = await applyInboxRules([mkMsg()], account, mockImap);

    expect(result.remaining).toHaveLength(0); // message removed from inbox
    const updateCall = query.mock.calls[1];
    expect(updateCall[0]).toMatch(/uid/i); // SQL includes uid update
    expect(updateCall[1]).toEqual(['INBOX/Work', 789, 'msg-1']);
  });

  it('updates only folder when uidMap is empty (no UIDPLUS)', async () => {
    const rule = mkRule([{ type: 'move', value: 'INBOX/Work' }]);
    query
      .mockResolvedValueOnce({ rows: [rule] })
      .mockResolvedValueOnce({ rows: [] });
    mockImap.bulkMoveMessages.mockResolvedValue({
      failed: [],
      uidMap: new Map(), // empty — non-UIDPLUS server
    });

    const result = await applyInboxRules([mkMsg()], account, mockImap);

    expect(result.remaining).toHaveLength(0);
    const updateCall = query.mock.calls[1];
    expect(updateCall[1]).toEqual(['INBOX/Work', 'msg-1']); // only folder, no uid
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

describe('applyInboxRules — already-relocated message skips subsequent rules', () => {
  it('does not apply a second MOVE rule after the first rule moved the message', async () => {
    const rule1 = mkRule(
      [{ type: 'move', value: 'INBOX/Work' }],
      { id: 'rule-1', stop_processing: false }
    );
    const rule2 = mkRule(
      [{ type: 'move', value: 'INBOX/Spam' }],
      { id: 'rule-2', stop_processing: false }
    );
    query
      .mockResolvedValueOnce({ rows: [rule1, rule2] }) // getRulesForAccount
      .mockResolvedValueOnce({ rows: [] });              // UPDATE folder (rule1 move)
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [], uidMap: new Map([[100, 200]]) });

    const result = await applyInboxRules([mkMsg()], account, mockImap);

    // message removed from remaining; second move never fired
    expect(result.remaining).toHaveLength(0);
    expect(mockImap.bulkMoveMessages).toHaveBeenCalledOnce();
    expect(mockImap.bulkMoveMessages).toHaveBeenCalledWith(account, [100], 'INBOX', 'INBOX/Work');
  });

  it('applies a subsequent mark_read rule even after an earlier rule moved the message', async () => {
    // Real-world scenario: rule 1 moves to a folder, rule 2 marks as read.
    // Both share the same condition. mark_read should still apply because it
    // operates on msg.id (not the stale INBOX uid) and is not a destination action.
    const rule1 = mkRule(
      [{ type: 'move', value: 'INBOX/Work' }],
      { id: 'rule-1', stop_processing: false }
    );
    const rule2 = mkRule(
      [{ type: 'mark_read', value: '' }],
      { id: 'rule-2', stop_processing: false }
    );
    query
      .mockResolvedValueOnce({ rows: [rule1, rule2] }) // getRulesForAccount
      .mockResolvedValueOnce({ rows: [] })               // UPDATE folder+uid (rule1 move)
      .mockResolvedValueOnce({ rows: [] });               // UPDATE is_read (rule2 mark_read)
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [], uidMap: new Map([[100, 200]]) });
    mockImap.setFlag.mockResolvedValue(undefined);

    const result = await applyInboxRules([mkMsg()], account, mockImap);

    expect(result.remaining).toHaveLength(0); // message still moved
    // mark_read DB update fired: third query call (after rules fetch + move update)
    expect(query).toHaveBeenCalledTimes(3);
    // setFlag targeted the NEW uid (200) in the destination folder (INBOX/Work)
    expect(mockImap.setFlag).toHaveBeenCalledWith(account, 200, 'INBOX/Work', '\\Seen', true);
  });

  it('does not double-decrement unread count when mark_read fires before move (reversed priority)', async () => {
    // Rule 1 (priority 0): mark_read. Rule 2 (priority 1): move.
    // mark_read must set msg.is_read = true in-memory so the subsequent move's
    // wasUnread check sees the updated state and does not decrement unread again.
    const rule1 = mkRule(
      [{ type: 'mark_read', value: '' }],
      { id: 'rule-1', stop_processing: false }
    );
    const rule2 = mkRule(
      [{ type: 'move', value: 'INBOX/Work' }],
      { id: 'rule-2', stop_processing: false }
    );
    query
      .mockResolvedValueOnce({ rows: [rule1, rule2] }) // getRulesForAccount
      .mockResolvedValueOnce({ rows: [] })               // UPDATE is_read (rule1 mark_read)
      .mockResolvedValueOnce({ rows: [] });               // UPDATE folder+uid (rule2 move)
    mockImap.setFlag.mockResolvedValue(undefined);
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [], uidMap: new Map([[100, 200]]) });

    await applyInboxRules([mkMsg({ is_read: false })], account, mockImap);

    // mark_read should adjust INBOX unread (-1); move should NOT adjust unread again
    // because wasUnread is false after mark_read updated msg.is_read in-memory.
    expect(adjustFolderCounts).toHaveBeenCalledWith('acc-1', 'INBOX', 0, -1);  // mark_read
    expect(adjustFolderCounts).toHaveBeenCalledWith('acc-1', 'INBOX', -1, 0);  // move source (no unread delta)
    expect(adjustFolderCounts).toHaveBeenCalledWith('acc-1', 'INBOX/Work', 1, 0); // move dest (no unread delta)
    expect(adjustFolderCounts).toHaveBeenCalledTimes(3);
  });
});

describe('applyInboxRules — mutedIds for mark_read', () => {
  it('adds message id to mutedIds when mark_read rule applies', async () => {
    const rule = mkRule([{ type: 'mark_read', value: '' }]);
    query
      .mockResolvedValueOnce({ rows: [rule] }) // getRulesForAccount
      .mockResolvedValueOnce({ rows: [] });     // UPDATE is_read
    mockImap.setFlag.mockResolvedValue(undefined);

    const result = await applyInboxRules([mkMsg()], account, mockImap);

    expect(result.remaining).toHaveLength(1); // message stays in inbox
    expect(result.mutedIds.has('msg-1')).toBe(true);
  });

  it('does not add message id to mutedIds when only star rule applies', async () => {
    const rule = mkRule([{ type: 'star', value: '' }]);
    query
      .mockResolvedValueOnce({ rows: [rule] }) // getRulesForAccount
      .mockResolvedValueOnce({ rows: [] });     // UPDATE is_starred
    mockImap.setFlag.mockResolvedValue(undefined);

    const result = await applyInboxRules([mkMsg()], account, mockImap);

    expect(result.remaining).toHaveLength(1);
    expect(result.mutedIds.has('msg-1')).toBe(false);
  });

  it('returns empty mutedIds when no rules match', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // no rules

    const result = await applyInboxRules([mkMsg()], account, mockImap);

    expect(result.remaining).toHaveLength(1);
    expect(result.mutedIds.size).toBe(0);
  });
});

describe('applyInboxRules — adjustFolderCounts on action', () => {
  it('calls adjustFolderCounts for source and destination after a successful move', async () => {
    const rule = mkRule([{ type: 'move', value: 'INBOX/Work' }]);
    query
      .mockResolvedValueOnce({ rows: [rule] })
      .mockResolvedValueOnce({ rows: [] });
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [], uidMap: new Map([[100, 200]]) });

    await applyInboxRules([mkMsg({ is_read: false })], account, mockImap);

    // unread message moved: source loses 1 total and 1 unread; dest gains 1 of each
    expect(adjustFolderCounts).toHaveBeenCalledWith('acc-1', 'INBOX', -1, -1);
    expect(adjustFolderCounts).toHaveBeenCalledWith('acc-1', 'INBOX/Work', 1, 1);
  });

  it('calls adjustFolderCounts with zero unread delta when message is already read', async () => {
    const rule = mkRule([{ type: 'move', value: 'INBOX/Work' }]);
    query
      .mockResolvedValueOnce({ rows: [rule] })
      .mockResolvedValueOnce({ rows: [] });
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [], uidMap: new Map([[100, 200]]) });

    await applyInboxRules([mkMsg({ is_read: true })], account, mockImap);

    expect(adjustFolderCounts).toHaveBeenCalledWith('acc-1', 'INBOX', -1, 0);
    expect(adjustFolderCounts).toHaveBeenCalledWith('acc-1', 'INBOX/Work', 1, 0);
  });

  it('calls adjustFolderCounts with unread delta only for mark_read on an unread message', async () => {
    const rule = mkRule([{ type: 'mark_read', value: '' }]);
    query
      .mockResolvedValueOnce({ rows: [rule] })
      .mockResolvedValueOnce({ rows: [] });
    mockImap.setFlag.mockResolvedValue(undefined);

    await applyInboxRules([mkMsg({ is_read: false })], account, mockImap);

    expect(adjustFolderCounts).toHaveBeenCalledWith('acc-1', 'INBOX', 0, -1);
    expect(adjustFolderCounts).toHaveBeenCalledTimes(1);
  });

  it('does not call adjustFolderCounts for mark_read when message is already read', async () => {
    const rule = mkRule([{ type: 'mark_read', value: '' }]);
    query
      .mockResolvedValueOnce({ rows: [rule] })
      .mockResolvedValueOnce({ rows: [] });
    mockImap.setFlag.mockResolvedValue(undefined);

    await applyInboxRules([mkMsg({ is_read: true })], account, mockImap);

    expect(adjustFolderCounts).not.toHaveBeenCalled();
  });
});

describe('applyInboxRules — from not_contains requires both name and email to not match', () => {
  it('does not fire when email contains the value even if name does not', async () => {
    // Buggy OR semantics: name "Alice" doesn't contain "example.com", so the rule
    // would fire even though fromEmail does contain it. Correct AND semantics: neither
    // email NOR name must contain the value.
    const rule = mkRule(
      [{ type: 'move', value: 'INBOX/Filtered' }],
      { conditions: [{ field: 'from', operator: 'not_contains', value: 'example.com' }] }
    );
    query.mockResolvedValueOnce({ rows: [rule] });

    const msg = mkMsg({ fromEmail: 'alice@example.com', fromName: 'Alice' });
    const result = await applyInboxRules([msg], account, mockImap);

    // email contains 'example.com' → condition false → no move
    expect(result.remaining).toHaveLength(1);
    expect(mockImap.bulkMoveMessages).not.toHaveBeenCalled();
  });

  it('fires when neither email nor name contains the value', async () => {
    const rule = mkRule(
      [{ type: 'move', value: 'INBOX/Filtered' }],
      { conditions: [{ field: 'from', operator: 'not_contains', value: 'example.com' }] }
    );
    query
      .mockResolvedValueOnce({ rows: [rule] })
      .mockResolvedValueOnce({ rows: [] });
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [], uidMap: new Map() });

    const msg = mkMsg({ fromEmail: 'alice@other.net', fromName: 'Alice' });
    const result = await applyInboxRules([msg], account, mockImap);

    // neither field contains 'example.com' → condition true → move fires
    expect(result.remaining).toHaveLength(0);
    expect(mockImap.bulkMoveMessages).toHaveBeenCalledOnce();
  });
});

describe('applyInboxRules — to not_contains requires all recipients to not match', () => {
  it('does not fire when any recipient address contains the value', async () => {
    // Buggy some() semantics: addr B doesn't contain 'filtered', so some() returns true
    // for that element → rule fires even though addr A does contain 'filtered'.
    // Correct every() semantics: ALL recipients must not contain the value.
    const rule = mkRule(
      [{ type: 'move', value: 'INBOX/Filtered' }],
      { conditions: [{ field: 'to', operator: 'not_contains', value: 'filtered' }] }
    );
    query.mockResolvedValueOnce({ rows: [rule] });

    const msg = mkMsg({
      to: [
        { email: 'a@filtered.com', name: 'A' },
        { email: 'b@other.com', name: 'B' },
      ],
    });
    const result = await applyInboxRules([msg], account, mockImap);

    // addr A contains 'filtered' → condition false → no move
    expect(result.remaining).toHaveLength(1);
    expect(mockImap.bulkMoveMessages).not.toHaveBeenCalled();
  });

  it('fires when all recipients and their names do not contain the value', async () => {
    const rule = mkRule(
      [{ type: 'move', value: 'INBOX/Filtered' }],
      { conditions: [{ field: 'to', operator: 'not_contains', value: 'filtered' }] }
    );
    query
      .mockResolvedValueOnce({ rows: [rule] })
      .mockResolvedValueOnce({ rows: [] });
    mockImap.bulkMoveMessages.mockResolvedValue({ failed: [], uidMap: new Map() });

    const msg = mkMsg({
      to: [
        { email: 'a@other.com', name: 'Alice' },
        { email: 'b@other.net', name: 'Bob' },
      ],
    });
    const result = await applyInboxRules([msg], account, mockImap);

    // no recipient contains 'filtered' → condition true → move fires
    expect(result.remaining).toHaveLength(0);
    expect(mockImap.bulkMoveMessages).toHaveBeenCalledOnce();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

import { query } from './db.js';
import {
  applyLabel,
  removeExactLabelCopy,
  removeLabel,
  removeLabelRow,
  resolveLabelCopyUid,
  markThreadRead,
  markThreadRowsRead,
  ensureLabelFolders,
} from './labels.js';

const account = { id: 'acct-1' };
const mkImap = () => ({ ensureFolder: vi.fn(), copyMessage: vi.fn(), removeMessageCopy: vi.fn() });

beforeEach(() => query.mockReset());

describe('label copy primitives', () => {
  it('uses the acted row directly when it already lives in the folder', async () => {
    await expect(resolveLabelCopyUid(
      { folder: 'Todo', uid: 42, account_id: 'a', message_id: '<m>' }, 'Todo',
    )).resolves.toBe(42);
    expect(query).not.toHaveBeenCalled();
  });

  it('resolves a sibling copy by account, folder, and Message-ID', async () => {
    query.mockResolvedValueOnce({ rows: [{
      id: 'row-99', account_id: 'a', uid: 99, folder: 'Todo',
      folder_uid_validity: '202', folder_observation_generation: '8',
    }] });
    await expect(resolveLabelCopyUid(
      { folder: 'INBOX', uid: 1, account_id: 'a', message_id: '<m>' }, 'Todo',
    )).resolves.toBe(99);
    expect(query.mock.calls[0][0]).toMatch(/m\.account_id = \$1 AND m\.folder = \$2 AND m\.message_id = \$3/);
    expect(query.mock.calls[0][0]).toMatch(/JOIN folders/);
    expect(query.mock.calls[0][0]).toMatch(/metadata_complete = true/);
    expect(query.mock.calls[0][0]).toMatch(/uid_validity IS NOT NULL/);
    expect(query.mock.calls[0][1]).toEqual(['a', 'Todo', '<m>']);
  });

  it('returns null when no sibling exists or the source lacks Message-ID', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(resolveLabelCopyUid(
      { folder: 'INBOX', uid: 1, account_id: 'a', message_id: '<m>' }, 'Todo',
    )).resolves.toBeNull();
    await expect(resolveLabelCopyUid(
      { folder: 'INBOX', uid: 1, account_id: 'a', message_id: null }, 'Todo',
    )).resolves.toBeNull();
  });

  it('fails closed when Message-ID discovers more than one eligible sibling', async () => {
    query.mockResolvedValueOnce({ rows: [
      { id: 'row-a', uid: 9, folder: 'Todo' },
      { id: 'row-b', uid: 10, folder: 'Todo' },
    ] });
    await expect(resolveLabelCopyUid(
      { folder: 'INBOX', uid: 1, account_id: 'a', message_id: '<duplicate>' }, 'Todo',
    )).rejects.toMatchObject({ code: 'AMBIGUOUS_LABEL_COPY' });
    expect(query.mock.calls[0][0]).not.toMatch(/LIMIT 1/);
  });

  it('ensures the target folder, copies an exact snapshot, and returns its destination UID', async () => {
    const imap = mkImap();
    imap.copyMessage.mockResolvedValueOnce(77);
    const message = {
      id: 'row-7', account_id: 'acct-1', uid: 7, folder: 'INBOX',
      folder_uid_validity: '101', folder_observation_generation: '4',
      read_revision: 2, star_revision: 3,
    };
    await expect(applyLabel(
      imap, account, message, 'Todo', { operationKey: 'label-1' },
    )).resolves.toEqual({ applied: true, uid: 77 });
    expect(imap.ensureFolder).toHaveBeenCalledWith(account, 'Todo');
    expect(imap.copyMessage).toHaveBeenCalledWith(
      'acct-1', 7, 'INBOX', 'Todo', {
        operationKey: 'label-1',
        snapshot: {
          id: 'row-7', accountId: 'acct-1', uid: 7, folder: 'INBOX',
          uidValidity: '101', folderGeneration: '4', readRevision: 2, starRevision: 3,
        },
      },
    );
  });

  it('reports a successful non-UIDPLUS copy without inventing an identity', async () => {
    const imap = mkImap();
    imap.copyMessage.mockResolvedValueOnce(null);
    const r = await applyLabel(imap, account, { uid: 7, folder: 'INBOX' }, 'Todo');
    expect(r).toEqual({ applied: true, uid: null });
  });

  it('is a no-op when the message already lives in the label folder', async () => {
    const imap = mkImap();
    const r = await applyLabel(imap, account, { uid: 7, folder: 'Todo' }, 'Todo');
    expect(r).toEqual({ applied: false, uid: 7, reason: 'already-there' });
    expect(imap.ensureFolder).not.toHaveBeenCalled();
    expect(imap.copyMessage).not.toHaveBeenCalled();
  });

  it('is a no-op when a sibling already carries the label', async () => {
    query.mockResolvedValueOnce({ rows: [{ uid: 91 }] });
    const imap = mkImap();
    const r = await applyLabel(imap, account, {
      account_id: 'acct-1', uid: 7, folder: 'INBOX', message_id: '<m>',
    }, 'Todo');
    expect(r).toEqual({ applied: false, uid: 91, reason: 'already-labelled' });
    expect(imap.ensureFolder).not.toHaveBeenCalled();
    expect(imap.copyMessage).not.toHaveBeenCalled();
  });
});

describe('removeExactLabelCopy', () => {
  const source = { account_id: 'acct-1', message_id: '<source@example.com>', thread_key: 'thread-1' };
  const exactCopy = {
    id: 'row-77', account_id: 'acct-1', uid: 77, folder: 'Todo',
    folder_uid_validity: 202, folder_observation_generation: 8,
    read_revision: 2, star_revision: 3,
  };

  it('removes only the requested UID when it belongs to the exact source message', async () => {
    query.mockResolvedValueOnce({ rows: [exactCopy] });
    const imap = mkImap();
    imap.removeMessageCopy.mockResolvedValueOnce(1);
    const result = await removeExactLabelCopy(imap, source, 'Todo', 77);

    expect(result).toEqual({ removed: true, alreadyGone: false });
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/message_id = \$4/), [
      'acct-1', 'Todo', 77, '<source@example.com>',
    ]);
    expect(imap.removeMessageCopy).toHaveBeenCalledWith('acct-1', 77, 'Todo', {
      expectedId: 'row-77',
      expectedUidValidity: 202,
      notify: true,
      snapshot: {
        id: 'row-77', accountId: 'acct-1', uid: 77, folder: 'Todo',
        uidValidity: '202', folderGeneration: '8', readRevision: 2, starRevision: 3,
      },
    });
  });

  it('does not remove an absent UID or a UID belonging to another message', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const imap = mkImap();
    const result = await removeExactLabelCopy(imap, source, 'Todo', 77);

    expect(result).toEqual({ removed: false });
    expect(imap.removeMessageCopy).not.toHaveBeenCalled();
  });

  it('does not advertise an unverifiable inverse for a source without a Message-ID', async () => {
    const imap = mkImap();
    const result = await removeExactLabelCopy(
      imap,
      { account_id: 'acct-1', message_id: null, thread_key: 'row-specific-key' },
      'Todo',
      77,
    );

    expect(result).toEqual({ removed: false });
    expect(query).not.toHaveBeenCalled();
    expect(imap.removeMessageCopy).not.toHaveBeenCalled();
  });
});

describe('label removal and folder setup', () => {
  it('does not copy a message already in the label folder', async () => {
    const imap = mkImap();
    await expect(applyLabel(imap, account, { uid: 7, folder: 'Todo' }, 'Todo'))
      .resolves.toEqual({ applied: false, uid: 7, reason: 'already-there' });
    expect(imap.ensureFolder).not.toHaveBeenCalled();
    expect(imap.copyMessage).not.toHaveBeenCalled();
  });

  it('removes a resolved sibling and no-ops when none exists', async () => {
    query.mockResolvedValueOnce({ rows: [{
      id: 'label-row', account_id: 'acct-1', uid: 99, folder: 'Todo',
      folder_uid_validity: '202', folder_observation_generation: '8',
    }] }).mockResolvedValueOnce({ rows: [] });
    const imap = mkImap();
    const source = { account_id: 'acct-1', uid: 1, folder: 'INBOX', message_id: '<m>' };
    await expect(removeLabel(imap, source, 'Todo')).resolves.toEqual({ removed: true });
    await expect(removeLabel(imap, source, 'Watch')).resolves.toEqual({ removed: false });
    expect(imap.removeMessageCopy).toHaveBeenCalledOnce();
    expect(imap.removeMessageCopy).toHaveBeenCalledWith('acct-1', 99, 'Todo', {
      expectedId: 'label-row', expectedUidValidity: '202',
      snapshot: expect.objectContaining({ id: 'label-row', folderGeneration: '8' }),
    });
  });

  it('removes one exact snapshot row and preserves UIDVALIDITY', async () => {
    const imap = mkImap();
    imap.removeMessageCopy.mockResolvedValueOnce(1);
    const row = {
      id: 'row-1', account_id: 'acct-1', uid: 99, folder: 'Todo', folder_uid_validity: 123,
    };
    await expect(removeLabelRow(imap, row, { notify: false })).resolves.toEqual({
      removed: true, alreadyGone: false,
    });
    expect(imap.removeMessageCopy).toHaveBeenCalledWith('acct-1', 99, 'Todo', {
      expectedId: 'row-1', notify: false, expectedUidValidity: 123,
      snapshot: expect.objectContaining({ id: 'row-1', uidValidity: '123' }),
    });
  });

  it('treats an exact row already removed concurrently as idempotent success', async () => {
    const imap = mkImap();
    imap.removeMessageCopy.mockResolvedValueOnce(0);
    await expect(removeLabelRow(imap, {
      id: 'row-1', account_id: 'acct-1', uid: 99, folder: 'Todo',
    }, { notify: false })).resolves.toEqual({ removed: false, alreadyGone: true });
  });

  it('deduplicates and resolves label folder creation independently', async () => {
    const imap = { ensureFolder: vi.fn()
      .mockResolvedValueOnce({ path: 'INBOX.Todo', created: true })
      .mockResolvedValueOnce({ path: 'INBOX.Watch', created: false }) };
    await expect(ensureLabelFolders(imap, account, ['Todo', 'Watch', 'Todo']))
      .resolves.toEqual([
        { folder: 'Todo', path: 'INBOX.Todo', created: true },
        { folder: 'Watch', path: 'INBOX.Watch', created: false },
      ]);
    expect(imap.ensureFolder).toHaveBeenCalledTimes(2);
  });

  it('isolates one label-folder failure and continues', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const imap = { ensureFolder: vi.fn()
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce({ path: 'Watch', created: true }) };
    try {
      await expect(ensureLabelFolders(imap, account, ['Todo', 'Watch'])).resolves.toEqual([
        { folder: 'Todo', error: true },
        { folder: 'Watch', path: 'Watch', created: true },
      ]);
    } finally {
      error.mockRestore();
    }
  });
});

const exactRows = [
  { id: 'i1', account_id: 'acct-1', uid: 5, folder: 'INBOX', is_read: false,
    folder_uid_validity: 101, folder_observation_generation: 201,
    read_revision: 0, star_revision: 0 },
  { id: 't1', account_id: 'acct-1', uid: 9, folder: 'Todo', is_read: false,
    folder_uid_validity: 102, folder_observation_generation: 202,
    read_revision: 3, star_revision: 1 },
  { id: 's1', account_id: 'acct-1', uid: 11, folder: 'Sent', is_read: true,
    folder_uid_validity: 103, folder_observation_generation: 203,
    read_revision: 4, star_revision: 2 },
];
const confirmedSeen = (changed, revision = 1) => ({
  changed,
  acceptance: { delivery: { revision } },
  delivery: { state: 'confirmed' },
});

describe('revisioned desired Seen fan-out', () => {
  it('returns the exact post-acceptance revision for destructive snapshot handoff', async () => {
    const imap = { setDesiredFlag: vi.fn().mockResolvedValue({
      changed: true,
      acceptance: { delivery: { revision: 9 } },
      delivery: { state: 'confirmed' },
    }) };

    await expect(markThreadRowsRead(imap, account, [exactRows[0]])).resolves.toMatchObject({
      changedCount: 1,
      seenFailedCount: 0,
      postSeenRows: [{ ...exactRows[0], is_read: true, read_revision: 9 }],
    });
  });

  it('terminates the frozen Seen lifecycle when the desired row snapshot is superseded', async () => {
    const imap = { setDesiredFlag: vi.fn().mockRejectedValue(Object.assign(
      new Error('row moved'),
      { code: 'DESIRED_FLAG_ROW_SUPERSEDED', retryable: true },
    )) };

    await expect(markThreadRowsRead(imap, account, [exactRows[0]])).rejects.toMatchObject({
      code: 'DESIRED_FLAG_ROW_SUPERSEDED', retryable: false,
    });
  });

  it('creates one independent exact-row delivery for every GTD snapshot row', async () => {
    const imap = { setDesiredFlag: vi.fn()
      .mockResolvedValueOnce(confirmedSeen(true))
      .mockResolvedValueOnce(confirmedSeen(true, 4))
      .mockResolvedValueOnce(confirmedSeen(false, 5)) };
    await expect(markThreadRowsRead(imap, account, exactRows)).resolves.toEqual({
      changedCount: 2, seenFailedCount: 0,
      postSeenRows: [
        { ...exactRows[0], is_read: true, read_revision: 1 },
        { ...exactRows[1], is_read: true, read_revision: 4 },
        { ...exactRows[2], is_read: true, read_revision: 5 },
      ],
    });
    expect(imap.setDesiredFlag).toHaveBeenCalledTimes(3);
    expect(imap.setDesiredFlag).toHaveBeenNthCalledWith(
      1, account, 'i1', '\\Seen', true,
      { snapshot: expect.objectContaining({
        id: 'i1', accountId: 'acct-1', uid: 5, folder: 'INBOX',
        uidValidity: '101', folderGeneration: '201', readRevision: 0,
      }) },
    );
  });

  it('awaits every delivery before destructive GTD work can continue', async () => {
    let release;
    const imap = { setDesiredFlag: vi.fn(() => new Promise(resolve => { release = resolve; })) };
    let settled = false;
    const pending = markThreadRowsRead(imap, account, [exactRows[0]])
      .then(result => { settled = true; return result; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release(confirmedSeen(true));
    await expect(pending).resolves.toEqual({
      changedCount: 1, seenFailedCount: 0,
      postSeenRows: [{ ...exactRows[0], is_read: true, read_revision: 1 }],
    });
  });

  it('continues independently after uncertainty and reports the failed delivery', async () => {
    const imap = { setDesiredFlag: vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('disconnect'), { uncertain: true }))
      .mockResolvedValueOnce(confirmedSeen(true, 4)) };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(markThreadRowsRead(imap, account, exactRows.slice(0, 2)))
        .resolves.toEqual({
          changedCount: 1, seenFailedCount: 1,
          postSeenRows: [{ ...exactRows[1], is_read: true, read_revision: 4 }],
        });
      expect(imap.setDesiredFlag).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('blocks GTD destructive work when non-CONDSTORE delivery resolves uncertain', async () => {
    const imap = { setDesiredFlag: vi.fn().mockResolvedValue({
      changed: true,
      delivery: { state: 'uncertain', condstore: false, uncertaintyTombstones: [{}] },
    }) };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(markThreadRowsRead(imap, account, [exactRows[0]])).resolves.toEqual({
        changedCount: 1, seenFailedCount: 1,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('blocks GTD destructive work when same-MODSEQ reassertion remains uncertain', async () => {
    const imap = { setDesiredFlag: vi.fn().mockResolvedValue({
      changed: false,
      delivery: {
        state: 'uncertain', condstore: true, capturedModseq: '44',
        uncertaintyTombstones: [{ baseline: '44' }],
      },
    }) };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(markThreadRowsRead(imap, account, [exactRows[2]])).resolves.toEqual({
        changedCount: 0, seenFailedCount: 1,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('reasserts Seen even for rows already read locally', async () => {
    const imap = { setDesiredFlag: vi.fn().mockResolvedValue({
      ...confirmedSeen(false, 5),
    }) };
    await expect(markThreadRowsRead(imap, account, [exactRows[2]])).resolves.toEqual({
      changedCount: 0, seenFailedCount: 0,
      postSeenRows: [{ ...exactRows[2], is_read: true, read_revision: 5 }],
    });
    expect(imap.setDesiredFlag).toHaveBeenCalledOnce();
  });

  it('deduplicates duplicate snapshot ids and handles an empty snapshot', async () => {
    const imap = { setDesiredFlag: vi.fn().mockResolvedValue({
      ...confirmedSeen(true),
    }) };
    await expect(markThreadRowsRead(imap, account, [exactRows[0], exactRows[0]]))
      .resolves.toEqual({
        changedCount: 1, seenFailedCount: 0,
        postSeenRows: [{ ...exactRows[0], is_read: true, read_revision: 1 }],
      });
    await expect(markThreadRowsRead(imap, account, [])).resolves.toEqual({
      changedCount: 0, seenFailedCount: 0,
    });
    expect(imap.setDesiredFlag).toHaveBeenCalledOnce();
  });

  it('uses exact live sibling rows for thread fan-out and never provider-mutates by Message-ID', async () => {
    query.mockResolvedValueOnce({ rows: exactRows });
    const imap = { setDesiredFlag: vi.fn().mockResolvedValue({ changed: true }), setFlag: vi.fn() };
    const result = await markThreadRead(imap, account, {
      account_id: 'acct-1', message_id: '<thread@example>',
    });
    expect(query.mock.calls[0][0]).toMatch(/JOIN folders/);
    expect(query.mock.calls[0][0]).toMatch(/metadata_complete = true/);
    expect(imap.setDesiredFlag).toHaveBeenCalledTimes(3);
    expect(imap.setFlag).not.toHaveBeenCalled();
    expect(result.inboxCopy).toEqual(exactRows[0]);
  });

  it('returns the Inbox anchor plus an error if one independent delivery fails', async () => {
    query.mockResolvedValueOnce({ rows: exactRows });
    const imap = { setDesiredFlag: vi.fn()
      .mockResolvedValueOnce({ changed: true })
      .mockRejectedValueOnce(new Error('delivery failed')) };
    const result = await markThreadRead(imap, account, {
      account_id: 'acct-1', message_id: '<thread@example>',
    });
    expect(result.inboxCopy).toEqual(exactRows[0]);
    expect(result.error).toMatchObject({ message: 'delivery failed' });
    expect(imap.setDesiredFlag).toHaveBeenCalledTimes(3);
  });

  it('returns a null Inbox anchor and performs no delivery when no live siblings remain', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const imap = { setDesiredFlag: vi.fn() };
    await expect(markThreadRead(imap, account, {
      account_id: 'acct-1', message_id: '<thread@example>',
    })).resolves.toEqual({ inboxCopy: null });
    expect(imap.setDesiredFlag).not.toHaveBeenCalled();
  });
});

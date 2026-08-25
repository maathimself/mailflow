import { describe, expect, it, vi } from 'vitest';

import { executeGtdDonePhases } from './gtdDonePhases.js';

const row = (id, folder, uid) => ({
  id, account_id: 'acct-1', thread_key: 'thread-1', folder, uid,
  is_read: true, read_revision: 1, star_revision: 0,
  folder_uid_validity: folder === 'INBOX' ? 10 : 20,
  folder_observation_generation: 3,
});

function operation(overrides = {}) {
  return {
    key: 'done-key', phase: 'seen', itemIndex: 0,
    plan: {
      rows: [
        row('label-other', 'Delegated', 2), row('label-anchor', 'Watch', 1),
        row('inbox-a', 'INBOX', 10), row('inbox-z', 'INBOX', 11),
      ],
      inboxRows: [row('inbox-z', 'INBOX', 11), row('inbox-a', 'INBOX', 10)],
      labelRows: [row('label-other', 'Delegated', 2), row('label-anchor', 'Watch', 1)],
      labelAnchorId: 'label-anchor', inboxAnchorId: 'inbox-a', targetFolders: ['Watch', 'Delegated'],
    },
    ...overrides,
  };
}

function deps(overrides = {}) {
  return {
    claim: vi.fn(async op => ({ ...op, claimOwner: 'owner-1' })),
    renew: vi.fn(async op => op),
    release: vi.fn(async () => {}),
    markSeen: vi.fn(async rows => ({
      seenFailedCount: 0,
      postSeenRows: rows.map(current => ({ ...current, read_revision: current.read_revision + 1 })),
    })),
    archive: vi.fn(async () => ({ archived: true })),
    removeLabel: vi.fn(async () => ({ removed: true, alreadyGone: false })),
    advance: vi.fn(async (op, phase, itemIndex) => ({ ...op, phase, itemIndex })),
    ...overrides,
  };
}

describe('executeGtdDonePhases', () => {
  it('stops immediately after the first nonconclusive Seen delivery and reports only observed failures', async () => {
    const actions = deps({ markSeen: vi.fn(async () => ({ seenFailedCount: 1 })) });
    const result = await executeGtdDonePhases(operation(), actions);
    expect(result).toMatchObject({ complete: false, phase: 'seen', seenFailedCount: 1 });
    expect(actions.markSeen).toHaveBeenCalledTimes(1);
    expect(actions.markSeen).toHaveBeenCalledWith([expect.objectContaining({ id: 'label-other' })]);
    expect(actions.archive).not.toHaveBeenCalled();
    expect(actions.removeLabel).not.toHaveBeenCalled();
  });

  it('archives deterministic non-anchor rows before the fallback Inbox anchor and stops on the first uncertainty', async () => {
    const calls = [];
    const actions = deps({
      archive: vi.fn(async current => {
        calls.push(current.id);
        return current.id === 'inbox-z' ? { archived: false } : { archived: true };
      }),
    });
    const result = await executeGtdDonePhases(operation(), actions);
    expect(calls).toEqual(['inbox-z']);
    expect(result).toMatchObject({ complete: false, phase: 'archive', archiveUnconfirmedCount: 1 });
    expect(actions.removeLabel).not.toHaveBeenCalled();
  });

  it('removes non-anchor labels only after every archive is conclusive and removes the label anchor last', async () => {
    const calls = [];
    const actions = deps({
      archive: vi.fn(async current => { calls.push(`archive:${current.id}`); return { alreadyGone: true }; }),
      removeLabel: vi.fn(async current => { calls.push(`label:${current.id}`); return { removed: true }; }),
    });
    const result = await executeGtdDonePhases(operation(), actions);
    expect(result.complete).toBe(true);
    expect(calls).toEqual([
      'archive:inbox-z', 'archive:inbox-a',
      'label:label-other', 'label:label-anchor',
    ]);
  });

  it('keeps the label anchor retryable when a non-anchor label removal fails', async () => {
    const actions = deps({
      removeLabel: vi.fn(async current => {
        if (current.id === 'label-other') throw new Error('provider failed');
        return { removed: true };
      }),
    });
    await expect(executeGtdDonePhases(operation(), actions)).rejects.toThrow('provider failed');
    expect(actions.removeLabel).toHaveBeenCalledTimes(1);
    expect(actions.removeLabel.mock.calls[0][0].id).toBe('label-other');
  });

  it('completes a no-label Inbox Done after the deterministic Inbox anchor is archived', async () => {
    const op = operation({
      plan: {
        rows: [row('inbox-only', 'INBOX', 8)], inboxRows: [row('inbox-only', 'INBOX', 8)],
        labelRows: [], labelAnchorId: null, inboxAnchorId: 'inbox-only', targetFolders: ['Todo'],
      },
    });
    const actions = deps();
    const result = await executeGtdDonePhases(op, actions);
    expect(result.complete).toBe(true);
    expect(actions.archive).toHaveBeenCalledOnce();
    expect(actions.removeLabel).not.toHaveBeenCalled();
  });

  it('resumes at the first unrecorded item without replaying completed same-folder ledger entries', async () => {
    const op = operation({ phase: 'labels', itemIndex: 1 });
    const actions = deps();
    const result = await executeGtdDonePhases(op, actions);
    expect(result.complete).toBe(true);
    expect(actions.markSeen).not.toHaveBeenCalled();
    expect(actions.archive).not.toHaveBeenCalled();
    expect(actions.removeLabel).toHaveBeenCalledTimes(1);
    expect(actions.removeLabel.mock.calls[0][0].id).toBe('label-anchor');
  });

  it('resumes two exact label items in the same physical folder at the independent anchor cursor', async () => {
    const sameFolderA = row('same-folder-a', 'Waiting', 20);
    const sameFolderAnchor = row('same-folder-anchor', 'Waiting', 21);
    const op = operation({
      phase: 'labels',
      itemIndex: 1,
      plan: {
        rows: [sameFolderA, sameFolderAnchor],
        inboxRows: [],
        labelRows: [sameFolderA, sameFolderAnchor],
        labelAnchorId: sameFolderAnchor.id,
        inboxAnchorId: null,
        targetFolders: ['Waiting'],
      },
    });
    const actions = deps();

    await expect(executeGtdDonePhases(op, actions)).resolves.toMatchObject({ complete: true });
    expect(actions.removeLabel).toHaveBeenCalledTimes(1);
    expect(actions.removeLabel).toHaveBeenCalledWith(sameFolderAnchor);
    expect(actions.advance).toHaveBeenCalledWith(
      expect.objectContaining({ itemIndex: 1 }), 'labels', 2,
      expect.objectContaining({ rowId: sameFolderAnchor.id, itemIndex: 1 }), undefined,
    );
  });

  it('reports Inbox cleared when the archive-to-label cursor transition cannot be persisted', async () => {
    const actions = deps({
      advance: vi.fn(async (op, phase, itemIndex) => {
        if (phase === 'labels') throw new Error('ledger unavailable');
        return { ...op, phase, itemIndex };
      }),
    });

    await expect(executeGtdDonePhases(operation(), actions)).rejects.toMatchObject({
      message: 'ledger unavailable',
      gtdDonePhase: 'labels',
      inboxCleared: true,
    });
  });

  it('tags a failed final archive outcome write as Inbox-cleared uncertainty', async () => {
    const actions = deps({
      advance: vi.fn(async (op, phase, itemIndex) => {
        if (phase === 'archive' && itemIndex === 2) throw new Error('ledger unavailable');
        return { ...op, phase, itemIndex };
      }),
    });

    await expect(executeGtdDonePhases(operation(), actions)).rejects.toMatchObject({
      message: 'ledger unavailable',
      gtdDonePhase: 'archive',
      inboxCleared: true,
    });
  });

  it('records phase, row, and cursor identity with every durable provider outcome', async () => {
    const actions = deps();
    await executeGtdDonePhases(operation(), actions);

    expect(actions.advance).toHaveBeenCalledWith(
      expect.anything(), 'archive', 1,
      expect.objectContaining({ phase: 'archive', itemIndex: 0, rowId: 'inbox-z', archived: true }),
      undefined,
    );
    expect(actions.advance).toHaveBeenCalledWith(
      expect.anything(), 'labels', 1,
      expect.objectContaining({ phase: 'labels', itemIndex: 0, rowId: 'label-other', removed: true }),
      undefined,
    );
  });

  it('durably rebases every destructive worklist to the exact post-Seen revision', async () => {
    const actions = deps();
    await executeGtdDonePhases(operation(), actions);

    const seenAdvance = actions.advance.mock.calls.find(([, phase, index]) => phase === 'archive' && index === 0);
    expect(seenAdvance[4].rows.every(current => current.read_revision >= 2)).toBe(true);
    expect(seenAdvance[4].inboxRows.map(current => current.read_revision)).toEqual([2, 2]);
    expect(seenAdvance[4].labelRows.map(current => current.read_revision)).toEqual([2, 2]);
  });

  it('does not let a release failure mask an archive-incomplete durable outcome', async () => {
    const actions = deps({
      archive: vi.fn(async () => ({ archived: false })),
      release: vi.fn(async () => { throw new Error('release unavailable'); }),
    });

    await expect(executeGtdDonePhases(operation(), actions)).resolves.toMatchObject({
      complete: false, phase: 'archive', archiveUnconfirmedCount: 1,
    });
  });

  it('terminates a frozen lifecycle when an exact row snapshot is structurally superseded', async () => {
    const superseded = Object.assign(new Error('row moved'), {
      code: 'MESSAGE_SNAPSHOT_SUPERSEDED', retryable: true,
    });
    const actions = deps({ archive: vi.fn(async () => { throw superseded; }) });

    await expect(executeGtdDonePhases(operation(), actions)).rejects.toMatchObject({
      code: 'MESSAGE_SNAPSHOT_SUPERSEDED', retryable: false, gtdDonePhase: 'archive',
    });
  });
});

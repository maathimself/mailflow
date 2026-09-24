import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ fanOutReadToSiblings: vi.fn() }));
import { query } from './db.js';
import { fanOutReadToSiblings } from '../utils/mailUtils.js';
import {
  applyLabel,
  removeExactLabelCopy,
  removeLabel,
  resolveLabelCopyUid,
  markThreadRead,
  ensureLabelFolders,
} from './labels.js';

const account = { id: 'acct-1' };
const mkImap = () => ({ ensureFolder: vi.fn(), copyMessage: vi.fn(), removeMessageCopy: vi.fn() });

beforeEach(() => { query.mockReset(); fanOutReadToSiblings.mockReset(); });

describe('resolveLabelCopyUid', () => {
  it('uses the acted row directly when it already lives in the folder', async () => {
    const uid = await resolveLabelCopyUid({ folder: 'Todo', uid: 42, account_id: 'a', message_id: '<m>' }, 'Todo');
    expect(uid).toBe(42);
    expect(query).not.toHaveBeenCalled(); // no DB lookup needed
  });

  it('resolves the sibling copy via shared Message-ID otherwise', async () => {
    query.mockResolvedValueOnce({ rows: [{ uid: 99 }] });
    const uid = await resolveLabelCopyUid({ folder: 'INBOX', uid: 1, account_id: 'a', message_id: '<m>' }, 'Todo');
    expect(uid).toBe(99);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/FROM messages WHERE account_id = \$1 AND folder = \$2 AND message_id = \$3/);
    expect(params).toEqual(['a', 'Todo', '<m>']);
  });

  it('returns null when no sibling exists, and when the message has no Message-ID', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await resolveLabelCopyUid({ folder: 'INBOX', uid: 1, account_id: 'a', message_id: '<m>' }, 'Todo')).toBeNull();
    expect(await resolveLabelCopyUid({ folder: 'INBOX', uid: 1, account_id: 'a', message_id: null }, 'Todo')).toBeNull();
  });
});

describe('applyLabel', () => {
  it('returns the exact UIDPLUS destination identity after copying', async () => {
    const imap = mkImap();
    imap.copyMessage.mockResolvedValueOnce(77);
    const r = await applyLabel(imap, account, { uid: 7, folder: 'INBOX' }, 'Todo');
    expect(r).toEqual({ applied: true, uid: 77 });
    expect(imap.ensureFolder).toHaveBeenCalledWith(account, 'Todo');
    expect(imap.copyMessage).toHaveBeenCalledWith('acct-1', 7, 'INBOX', 'Todo');
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

  it('removes only the requested UID when it belongs to the exact source message', async () => {
    query.mockResolvedValueOnce({ rows: [{ uid: 77 }] });
    const imap = mkImap();
    const result = await removeExactLabelCopy(imap, source, 'Todo', 77);

    expect(result).toEqual({ removed: true });
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/message_id = \$4/), [
      'acct-1', 'Todo', 77, '<source@example.com>',
    ]);
    expect(imap.removeMessageCopy).toHaveBeenCalledWith('acct-1', 77, 'Todo');
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

describe('removeLabel', () => {
  it('removes the resolved sibling copy from the label folder', async () => {
    query.mockResolvedValueOnce({ rows: [{ uid: 99 }] });
    const imap = mkImap();
    const r = await removeLabel(imap, { account_id: 'acct-1', uid: 1, folder: 'INBOX', message_id: '<m>' }, 'Todo');
    expect(r).toEqual({ removed: true });
    expect(imap.removeMessageCopy).toHaveBeenCalledWith('acct-1', 99, 'Todo');
  });

  it('is a no-op (no IMAP call) when no copy lives in the label folder', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const imap = mkImap();
    const r = await removeLabel(imap, { account_id: 'acct-1', uid: 1, folder: 'INBOX', message_id: '<m>' }, 'Todo');
    expect(r).toEqual({ removed: false });
    expect(imap.removeMessageCopy).not.toHaveBeenCalled();
  });
});

describe('ensureLabelFolders', () => {
  it('dedupes paths, resolves each to its real server path, and reports created', async () => {
    const imap = { ensureFolder: vi.fn()
      .mockResolvedValueOnce({ path: 'INBOX.Todo', created: true })
      .mockResolvedValueOnce({ path: 'INBOX.Watch', created: false }) };
    const results = await ensureLabelFolders(imap, account, ['Todo', 'Watch', 'Todo']);
    expect(results).toEqual([
      { folder: 'Todo', path: 'INBOX.Todo', created: true },
      { folder: 'Watch', path: 'INBOX.Watch', created: false },
    ]);
    expect(imap.ensureFolder).toHaveBeenCalledTimes(2); // 'Todo' deduped
    expect(imap.ensureFolder).toHaveBeenCalledWith(account, 'Todo', { resolvePath: true });
  });

  it('isolates a single folder failure and continues with the rest', async () => {
    const imap = { ensureFolder: vi.fn()
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce({ path: 'Watch', created: true }) };
    const results = await ensureLabelFolders(imap, account, ['Todo', 'Watch']);
    expect(results).toEqual([
      { folder: 'Todo', error: true },
      { folder: 'Watch', path: 'Watch', created: true },
    ]);
  });
});

describe('markThreadRead', () => {
  const msg = { account_id: 'acct-1', message_id: '<m>' };
  const imapMR = () => ({ setFlag: vi.fn() });

  it('fans out read state and sets \\Seen on an unread INBOX copy; returns the copy', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'i1', uid: 5, is_read: false }] });
    const imap = imapMR();
    const r = await markThreadRead(imap, { id: 'acct-1' }, msg);
    expect(fanOutReadToSiblings).toHaveBeenCalledWith('acct-1', '<m>', true);
    expect(imap.setFlag).toHaveBeenCalledWith({ id: 'acct-1' }, 5, 'INBOX', '\\Seen', true);
    expect(r.inboxCopy).toEqual({ id: 'i1', uid: 5, is_read: false });
    expect(r.error).toBeUndefined();
  });

  it('skips the flag push when the INBOX copy is already read', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'i1', uid: 5, is_read: true }] });
    const imap = imapMR();
    await markThreadRead(imap, { id: 'acct-1' }, msg);
    expect(fanOutReadToSiblings).toHaveBeenCalled();
    expect(imap.setFlag).not.toHaveBeenCalled();
  });

  it('handles no INBOX copy (nothing to flag, inboxCopy null)', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const imap = imapMR();
    const r = await markThreadRead(imap, { id: 'acct-1' }, msg);
    expect(r.inboxCopy).toBeNull();
    expect(imap.setFlag).not.toHaveBeenCalled();
  });

  it('degrades gracefully: a fan-out failure returns the copy + error, never throws', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'i1', uid: 5, is_read: false }] });
    fanOutReadToSiblings.mockRejectedValueOnce(new Error('db down'));
    const imap = imapMR();
    const r = await markThreadRead(imap, { id: 'acct-1' }, msg);
    expect(r.inboxCopy).toEqual({ id: 'i1', uid: 5, is_read: false }); // still available for archive
    expect(r.error).toBeInstanceOf(Error);
  });
});

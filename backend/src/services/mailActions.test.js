import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

import { query } from './db.js';
import {
  setMessageRead, setMessageStarred, moveSingleMessage,
  deleteSingleMessage, archiveSingleMessage,
} from './mailActions.js';

function makeImapManager(overrides = {}) {
  return {
    setFlag: vi.fn().mockResolvedValue(undefined),
    moveMessage: vi.fn().mockResolvedValue(42),
    ...overrides,
  };
}

const baseMessage = {
  id: 'm1', uid: 100, folder: 'INBOX', account_id: 'acc1',
  is_read: false, is_starred: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  // adjustFolderCounts calls query(...).catch(...) fire-and-forget; default must return a Promise
  query.mockResolvedValue({ rows: [] });
});

// ── setMessageRead ────────────────────────────────────────────────────────────

describe('setMessageRead', () => {
  it('throws 404 when message not found', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(setMessageRead('missing', 'u1', true, null)).rejects.toMatchObject({ status: 404 });
  });

  it('updates is_read and returns ok', async () => {
    query.mockResolvedValueOnce({ rows: [{ ...baseMessage, user_id: 'u1' }] });
    query.mockResolvedValueOnce({ rowCount: 1 });
    query.mockResolvedValueOnce({ rows: [{ ...baseMessage, account_id: 'acc1' }] });
    const result = await setMessageRead('m1', 'u1', true, null);
    expect(result).toEqual({ ok: true, is_read: true });
    expect(query.mock.calls[1][0]).toContain('UPDATE messages SET is_read');
  });

  it('fires IMAP setFlag when imapManager provided', async () => {
    const imap = makeImapManager();
    query.mockResolvedValueOnce({ rows: [{ ...baseMessage, user_id: 'u1' }] });
    query.mockResolvedValueOnce({ rowCount: 1 });
    query.mockResolvedValueOnce({ rows: [{ id: 'acc1', email_address: 'a@b.com' }] });
    await setMessageRead('m1', 'u1', true, imap);
    expect(imap.setFlag).toHaveBeenCalledWith(expect.any(Object), 100, 'INBOX', '\\Seen', true);
  });
});

// ── setMessageStarred ─────────────────────────────────────────────────────────

describe('setMessageStarred', () => {
  it('throws 404 when message not found', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(setMessageStarred('missing', 'u1', true, null)).rejects.toMatchObject({ status: 404 });
  });

  it('updates is_starred and returns ok', async () => {
    query.mockResolvedValueOnce({ rows: [{ ...baseMessage, user_id: 'u1' }] });
    query.mockResolvedValueOnce({ rowCount: 1 });
    query.mockResolvedValueOnce({ rows: [{ id: 'acc1' }] });
    const result = await setMessageStarred('m1', 'u1', true, null);
    expect(result).toEqual({ ok: true, is_starred: true });
  });

  it('fires IMAP setFlag with Flagged', async () => {
    const imap = makeImapManager();
    query.mockResolvedValueOnce({ rows: [{ ...baseMessage, user_id: 'u1' }] });
    query.mockResolvedValueOnce({ rowCount: 1 });
    query.mockResolvedValueOnce({ rows: [{ id: 'acc1', email_address: 'a@b.com' }] });
    await setMessageStarred('m1', 'u1', false, imap);
    expect(imap.setFlag).toHaveBeenCalledWith(expect.any(Object), 100, 'INBOX', '\\Flagged', false);
  });
});

// ── moveSingleMessage ─────────────────────────────────────────────────────────

describe('moveSingleMessage', () => {
  it('throws 404 when message not found', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(moveSingleMessage('missing', 'u1', 'Archive', makeImapManager())).rejects.toMatchObject({ status: 404 });
  });

  it('moves message and updates DB with new uid', async () => {
    const imap = makeImapManager({ moveMessage: vi.fn().mockResolvedValue(55) });
    query.mockResolvedValueOnce({ rows: [{ ...baseMessage, user_id: 'u1' }] });
    query.mockResolvedValueOnce({ rows: [{ id: 'acc1' }] });
    query.mockResolvedValueOnce({ rowCount: 1 });
    const result = await moveSingleMessage('m1', 'u1', 'Archive', imap);
    expect(result).toEqual({ ok: true });
    const updateCall = query.mock.calls[2];
    expect(updateCall[0]).toContain('folder = $1, uid = $2');
    expect(updateCall[1]).toEqual(['Archive', 55, 'm1']);
  });

  it('updates folder without uid when moveMessage returns null', async () => {
    const imap = makeImapManager({ moveMessage: vi.fn().mockResolvedValue(null) });
    query.mockResolvedValueOnce({ rows: [{ ...baseMessage, user_id: 'u1' }] });
    query.mockResolvedValueOnce({ rows: [{ id: 'acc1' }] });
    query.mockResolvedValueOnce({ rowCount: 1 });
    await moveSingleMessage('m1', 'u1', 'Archive', imap);
    const updateCall = query.mock.calls[2];
    expect(updateCall[0]).toContain('folder = $1');
    expect(updateCall[0]).not.toContain('uid');
  });
});

// ── deleteSingleMessage ───────────────────────────────────────────────────────

describe('deleteSingleMessage', () => {
  it('throws 404 when message not found', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(deleteSingleMessage('missing', 'u1', makeImapManager())).rejects.toMatchObject({ status: 404 });
  });

  it('moves to trash folder when one exists', async () => {
    const imap = makeImapManager({ moveMessage: vi.fn().mockResolvedValue(99) });
    query.mockResolvedValueOnce({ rows: [{ ...baseMessage, user_id: 'u1' }] });
    query.mockResolvedValueOnce({ rows: [{ path: 'Trash' }] });
    query.mockResolvedValueOnce({ rows: [{ id: 'acc1' }] });
    query.mockResolvedValueOnce({ rowCount: 1 });
    const result = await deleteSingleMessage('m1', 'u1', imap);
    expect(result.trashPath).toBe('Trash');
    expect(imap.moveMessage).toHaveBeenCalledWith(expect.any(Object), 100, 'INBOX', 'Trash');
  });

  it('marks as deleted when no trash folder', async () => {
    query.mockResolvedValueOnce({ rows: [{ ...baseMessage, user_id: 'u1' }] });
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [{ id: 'acc1' }] });
    query.mockResolvedValueOnce({ rowCount: 1 });
    const result = await deleteSingleMessage('m1', 'u1', makeImapManager());
    expect(result).toEqual({ ok: true });
    const updateCall = query.mock.calls.find(c => c[0].includes('is_deleted'));
    expect(updateCall).toBeTruthy();
  });
});

// ── archiveSingleMessage ──────────────────────────────────────────────────────

describe('archiveSingleMessage', () => {
  it('throws 404 when message not found', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(archiveSingleMessage('missing', 'u1', makeImapManager())).rejects.toMatchObject({ status: 404 });
  });

  it('throws 422 when no archive folder found', async () => {
    query.mockResolvedValueOnce({ rows: [{ ...baseMessage, user_id: 'u1', folder_mappings: null }] });
    query.mockResolvedValueOnce({ rows: [] });
    await expect(archiveSingleMessage('m1', 'u1', makeImapManager())).rejects.toMatchObject({ status: 422 });
  });

  it('moves to archive folder and returns archiveFolder', async () => {
    const imap = makeImapManager({ moveMessage: vi.fn().mockResolvedValue(77) });
    query.mockResolvedValueOnce({ rows: [{ ...baseMessage, user_id: 'u1', folder_mappings: null }] });
    query.mockResolvedValueOnce({ rows: [{ path: 'Archive' }] });
    query.mockResolvedValueOnce({ rows: [{ id: 'acc1' }] });
    query.mockResolvedValueOnce({ rowCount: 1 });
    const result = await archiveSingleMessage('m1', 'u1', imap);
    expect(result).toEqual({ ok: true, archiveFolder: 'Archive' });
  });

  it('respects folder_mappings.archive override', async () => {
    const imap = makeImapManager({ moveMessage: vi.fn().mockResolvedValue(77) });
    query.mockResolvedValueOnce({ rows: [{ ...baseMessage, user_id: 'u1', folder_mappings: { archive: 'MyArchive' } }] });
    query.mockResolvedValueOnce({ rows: [{ id: 'acc1' }] });
    query.mockResolvedValueOnce({ rowCount: 1 });
    const result = await archiveSingleMessage('m1', 'u1', imap);
    expect(result.archiveFolder).toBe('MyArchive');
  });
});

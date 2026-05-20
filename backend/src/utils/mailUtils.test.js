import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveTrashFolder, resolveArchiveFolder, getDeleteStrategy } from './mailUtils.js';

vi.mock('../services/db.js', () => ({
  query: vi.fn(),
}));

const { query } = await import('../services/db.js');

beforeEach(() => {
  query.mockClear();
});

describe('resolveTrashFolder', () => {
  it('returns folder_mappings.trash immediately without querying the DB', async () => {
    const result = await resolveTrashFolder(1, { trash: 'INBOX.Trash' });
    expect(result).toBe('INBOX.Trash');
    expect(query).not.toHaveBeenCalled();
  });

  it('falls back to special_use=\\Trash folder when no mapping is set', async () => {
    query.mockResolvedValue({ rows: [{ path: 'INBOX.Trash' }] });
    const result = await resolveTrashFolder(1, null);
    expect(result).toBe('INBOX.Trash');
    expect(query).toHaveBeenCalledOnce();
  });

  it('falls back to name heuristic when no special_use match exists', async () => {
    query.mockResolvedValue({ rows: [{ path: 'Deleted Messages' }] });
    const result = await resolveTrashFolder(2, {});
    expect(result).toBe('Deleted Messages');
  });

  it('returns null when no trash folder is found', async () => {
    query.mockResolvedValue({ rows: [] });
    const result = await resolveTrashFolder(3, undefined);
    expect(result).toBeNull();
  });
});

describe('resolveArchiveFolder', () => {
  it('returns folder_mappings.archive immediately without querying the DB', async () => {
    const result = await resolveArchiveFolder(1, { archive: 'INBOX.Archive' });
    expect(result).toBe('INBOX.Archive');
    expect(query).not.toHaveBeenCalled();
  });

  it('falls back to special_use=\\Archive folder when no mapping is set', async () => {
    query.mockResolvedValue({ rows: [{ path: 'Archive' }] });
    const result = await resolveArchiveFolder(1, null);
    expect(result).toBe('Archive');
    expect(query).toHaveBeenCalledOnce();
  });

  it('falls back to name heuristic when no special_use match exists', async () => {
    query.mockResolvedValue({ rows: [{ path: 'INBOX.archive-2024' }] });
    const result = await resolveArchiveFolder(2, {});
    expect(result).toBe('INBOX.archive-2024');
  });

  it('returns null when no archive folder is found', async () => {
    query.mockResolvedValue({ rows: [] });
    const result = await resolveArchiveFolder(3, undefined);
    expect(result).toBeNull();
  });

  it('uses ORDER BY to prefer special_use match over name heuristic', async () => {
    query.mockResolvedValue({ rows: [] });
    await resolveArchiveFolder(1, null);
    const sql = query.mock.calls[0][0];
    expect(sql).toContain("CASE WHEN special_use = '\\Archive' THEN 0 ELSE 1 END");
  });
});

describe('getDeleteStrategy', () => {
  it('returns no_trash when no Trash folder is configured', () => {
    expect(getDeleteStrategy('INBOX', null)).toEqual({ action: 'no_trash' });
    expect(getDeleteStrategy('INBOX', undefined)).toEqual({ action: 'no_trash' });
  });

  it('returns expunge when message is already in the Trash folder', () => {
    expect(getDeleteStrategy('INBOX/Trash', 'INBOX/Trash')).toEqual({ action: 'expunge' });
  });

  it('returns move when message is in a normal folder and Trash exists', () => {
    expect(getDeleteStrategy('INBOX', 'INBOX/Trash')).toEqual({ action: 'move', destination: 'INBOX/Trash' });
  });

  it('returns move when Trash mapping is stale (path comes from folder_mappings without DB check)', () => {
    // resolveTrashFolder returns the mapped path immediately, even if the folder no longer
    // exists on the server. getDeleteStrategy correctly returns 'move'; the IMAP call will
    // fail and the route's try/catch will surface the error to the caller.
    expect(getDeleteStrategy('INBOX', 'INBOX/OldTrash')).toEqual({ action: 'move', destination: 'INBOX/OldTrash' });
  });
});

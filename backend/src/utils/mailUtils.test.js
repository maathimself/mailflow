import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveTrashFolder, resolveArchiveFolder, isAllMailFolder, resolveSpamFolder, getDeleteStrategy, fanOutReadToSiblings, fanOutStarToSiblings, fanOutBulkReadToSiblings } from './mailUtils.js';

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

  it('falls back to special_use=\\All (Gmail All Mail) when nothing else matches', async () => {
    query.mockResolvedValue({ rows: [{ path: '[Gmail]/All Mail' }] });
    const result = await resolveArchiveFolder(4, {});
    expect(result).toBe('[Gmail]/All Mail');
  });

  it('returns null when no archive folder is found', async () => {
    query.mockResolvedValue({ rows: [] });
    const result = await resolveArchiveFolder(3, undefined);
    expect(result).toBeNull();
  });

  it('uses ORDER BY to prefer special_use=\\Archive, then name match, then \\All last', async () => {
    query.mockResolvedValue({ rows: [] });
    await resolveArchiveFolder(1, null);
    const sql = query.mock.calls[0][0];
    expect(sql).toContain("WHEN special_use = '\\Archive' THEN 0");
    expect(sql).toContain("WHEN lower(name) LIKE '%archive%' THEN 1");
  });
});

describe('isAllMailFolder', () => {
  it('returns false without querying the DB when path is falsy', async () => {
    const result = await isAllMailFolder(1, null);
    expect(result).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns true when the folder row has special_use = \\All', async () => {
    query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const result = await isAllMailFolder(1, '[Gmail]/All Mail');
    expect(result).toBe(true);
    expect(query).toHaveBeenCalledOnce();
  });

  it('returns false when no matching \\All row exists', async () => {
    query.mockResolvedValue({ rows: [] });
    const result = await isAllMailFolder(1, 'Archive');
    expect(result).toBe(false);
  });
});

describe('resolveSpamFolder', () => {
  it('returns folder_mappings.spam immediately without querying the DB', async () => {
    const result = await resolveSpamFolder(1, { spam: '[Gmail]/Spam' });
    expect(result).toBe('[Gmail]/Spam');
    expect(query).not.toHaveBeenCalled();
  });

  it('falls back to special_use=\\Junk folder when no mapping is set', async () => {
    query.mockResolvedValue({ rows: [{ path: 'Junk' }] });
    const result = await resolveSpamFolder(1, null);
    expect(result).toBe('Junk');
    expect(query).toHaveBeenCalledOnce();
  });

  it('falls back to multilingual name heuristic when no special_use match exists', async () => {
    query.mockResolvedValue({ rows: [{ path: 'Spamverdacht' }] });
    const result = await resolveSpamFolder(2, {});
    expect(result).toBe('Spamverdacht');
  });

  it('matches Outlook-style "Junk Email" folder name', async () => {
    query.mockResolvedValue({ rows: [{ path: 'Junk Email' }] });
    const result = await resolveSpamFolder(3, {});
    expect(result).toBe('Junk Email');
  });

  it('matches Italian "Posta indesiderata" folder name', async () => {
    query.mockResolvedValue({ rows: [{ path: 'Posta indesiderata' }] });
    const result = await resolveSpamFolder(4, {});
    expect(result).toBe('Posta indesiderata');
  });

  it('returns null when no spam folder is found', async () => {
    query.mockResolvedValue({ rows: [] });
    const result = await resolveSpamFolder(5, undefined);
    expect(result).toBeNull();
  });

  it('uses ORDER BY to prefer special_use match over name heuristic', async () => {
    query.mockResolvedValue({ rows: [] });
    await resolveSpamFolder(1, null);
    const sql = query.mock.calls[0][0];
    expect(sql).toContain("CASE WHEN special_use = '\\Junk' THEN 0 ELSE 1 END");
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

// ── read/star fan-out to sibling label rows ──────────────────────────────────
// With GTD multi-label siblings a message_id can own several rows (INBOX + Todo +
// Watch). Marking one read/starred must fan out to the rest, and read fan-out must
// adjust each sibling folder's unread count off the rows that actually flipped.

// query.mock.calls entries are [sql, params]; find the one whose SQL contains `frag`.
const callWith = (frag) => query.mock.calls.find(([sql]) => sql.includes(frag));
// All folder-count adjustments issued (adjustFolderCounts → UPDATE folders …).
const countCalls = () => query.mock.calls.filter(([sql]) => sql.includes('UPDATE folders'));

describe('fanOutReadToSiblings', () => {
  it('does nothing when the message has no Message-ID (no siblings possible)', async () => {
    await fanOutReadToSiblings('acct-1', null, true);
    expect(query).not.toHaveBeenCalled();
  });

  it('updates only sibling rows whose is_read differs and adjusts their folder counts', async () => {
    // Two siblings flip to read; the acted row is already read so it is not returned.
    query.mockResolvedValueOnce({ rows: [{ folder: 'Todo' }, { folder: 'Watch' }] });
    query.mockResolvedValue({ rows: [] }); // folder-count UPDATEs

    await fanOutReadToSiblings('acct-1', '<abc@x>', true);

    const upd = callWith('UPDATE messages SET is_read');
    expect(upd).toBeTruthy();
    // Scoped by account_id + message_id; prior-state filter excludes rows already at target.
    expect(upd[0]).toContain('WHERE account_id = $2 AND message_id = $3 AND is_read <> $1');
    expect(upd[0]).toContain('RETURNING folder');
    expect(upd[1]).toEqual([true, 'acct-1', '<abc@x>']);

    // One unread decrement per returned sibling folder (mark-read → unread −1).
    const counts = countCalls();
    expect(counts).toHaveLength(2);
    expect(counts.map(c => c[1])).toEqual(
      expect.arrayContaining([[0, -1, 'acct-1', 'Todo'], [0, -1, 'acct-1', 'Watch']])
    );
  });

  it('runs the UPDATE but adjusts no counts when there are no siblings to flip', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // nothing flipped
    await fanOutReadToSiblings('acct-1', '<solo@x>', true);
    expect(callWith('UPDATE messages SET is_read')).toBeTruthy();
    expect(countCalls()).toHaveLength(0);
  });

  it('increments unread on mark-unread fan-out', async () => {
    query.mockResolvedValueOnce({ rows: [{ folder: 'Todo' }] });
    query.mockResolvedValue({ rows: [] });
    await fanOutReadToSiblings('acct-1', '<abc@x>', false);
    expect(countCalls()[0][1]).toEqual([0, 1, 'acct-1', 'Todo']);
  });
});

describe('fanOutStarToSiblings', () => {
  it('does nothing when the message has no Message-ID', async () => {
    await fanOutStarToSiblings('acct-1', null, true);
    expect(query).not.toHaveBeenCalled();
  });

  it('updates sibling is_starred and never touches folder counts', async () => {
    query.mockResolvedValue({ rows: [{ folder: 'Todo' }] });
    await fanOutStarToSiblings('acct-1', '<abc@x>', true);
    const upd = callWith('UPDATE messages SET is_starred');
    expect(upd[0]).toContain('WHERE account_id = $2 AND message_id = $3 AND is_starred <> $1');
    expect(upd[1]).toEqual([true, 'acct-1', '<abc@x>']);
    expect(countCalls()).toHaveLength(0);
  });
});

describe('fanOutBulkReadToSiblings', () => {
  it('does nothing for an empty id set', async () => {
    await fanOutBulkReadToSiblings([], true);
    expect(query).not.toHaveBeenCalled();
  });

  it('flips siblings of the acted set (excluding the acted rows) and adjusts counts per folder', async () => {
    query.mockResolvedValueOnce({ rows: [{ account_id: 'a1', folder: 'Todo' }, { account_id: 'a1', folder: 'Todo' }] });
    query.mockResolvedValue({ rows: [] });

    await fanOutBulkReadToSiblings(['id1', 'id2'], true);

    const upd = callWith('UPDATE messages m SET is_read');
    expect(upd[0]).toContain('FROM (');                    // derives acted (account_id, message_id) pairs
    expect(upd[0]).toContain('m.id <> ALL($2::uuid[])');   // never re-count the acted rows
    expect(upd[0]).toContain('RETURNING m.account_id, m.folder');
    expect(upd[1]).toEqual([true, ['id1', 'id2']]);

    // Two flipped rows in the same folder aggregate to a single −2 unread adjustment.
    const counts = countCalls();
    expect(counts).toHaveLength(1);
    expect(counts[0][1]).toEqual([0, -2, 'a1', 'Todo']);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({
  resolveArchiveFolder: vi.fn(async () => '[Gmail]/All Mail'),
  isAllMailFolder: vi.fn(async () => true),
  adjustFolderCounts: vi.fn(),
}));

import { query } from './db.js';
import { adjustFolderCounts } from '../utils/mailUtils.js';
import { archiveInboxCopy } from './archiveInbox.js';

const account = { id: 'account-1', folder_mappings: {} };
const inboxCopy = { id: 'message-1', uid: 42 };

describe('archiveInboxCopy Gmail All Mail', () => {
  beforeEach(() => { query.mockReset(); adjustFolderCounts.mockReset(); });

  it('repoints the Inbox row to the synced All Mail folder and updates both counts', async () => {
    const manager = { _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(),
      moveMessage: vi.fn(async () => 101) };
    query.mockResolvedValueOnce({ rowCount: 1 });
    const result = await archiveInboxCopy(manager, account, inboxCopy);
    expect(result.archived).toBe(true);
    expect(query.mock.calls[0][0]).toMatch(/^UPDATE messages SET folder = \$1, uid = \$2/);
    expect(query.mock.calls[0][1]).toEqual(['[Gmail]/All Mail', 101, 'message-1']);
    expect(adjustFolderCounts).toHaveBeenCalledWith('account-1', 'INBOX', -1, 0);
    expect(adjustFolderCounts).toHaveBeenCalledWith('account-1', '[Gmail]/All Mail', 1, 0);
  });
});

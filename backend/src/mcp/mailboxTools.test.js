import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./accountAdapter.js', async (orig) => {
  const actual = await orig();
  return { ...actual, getAccountRow: vi.fn() };
});
vi.mock('../services/mailbox/folders.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    listFolders: vi.fn(),
    createFolder: vi.fn(),
    renameFolder: vi.fn(),
    deleteFolder: vi.fn(),
    countMessagesIn: vi.fn(),
  };
});
vi.mock('../services/mailbox/move.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    bulkMoveToFolder: vi.fn(),
    resolveMovedIds: vi.fn(),
  };
});
vi.mock('../services/mailbox/archive.js', async (orig) => {
  const actual = await orig();
  return { ...actual, bulkArchive: vi.fn() };
});
vi.mock('../services/mailbox/trash.js', async (orig) => {
  const actual = await orig();
  return { ...actual, bulkTrash: vi.fn() };
});
vi.mock('../services/mailbox/flags.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    bulkSetRead: vi.fn(),
    setStarred: vi.fn(),
  };
});
vi.mock('../services/mailbox/batch.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    runInBatches: vi.fn(actual.runInBatches),
  };
});
vi.mock('../services/mailbox/spamLabel.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    markSpam: vi.fn(),
    markNotSpam: vi.fn(),
  };
});
vi.mock('../services/mailbox/snooze.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    snoozeConversation: vi.fn(),
    unsnoozeConversation: vi.fn(),
  };
});
vi.mock('../services/mailbox/category.js', async (orig) => {
  const actual = await orig();
  return { ...actual, setCategory: vi.fn() };
});
vi.mock('../services/gtd/actions.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    gtdClassify: vi.fn(),
    gtdUnclassify: vi.fn(),
    gtdDone: vi.fn(),
  };
});

import { getAccountRow } from './accountAdapter.js';
import {
  countMessagesIn,
  createFolder,
  deleteFolder,
  listFolders,
  renameFolder,
} from '../services/mailbox/folders.js';
import {
  bulkMoveToFolder,
  resolveMovedIds,
} from '../services/mailbox/move.js';
import { bulkArchive } from '../services/mailbox/archive.js';
import { bulkTrash } from '../services/mailbox/trash.js';
import { bulkSetRead, setStarred } from '../services/mailbox/flags.js';
import { runInBatches } from '../services/mailbox/batch.js';
import { markNotSpam, markSpam } from '../services/mailbox/spamLabel.js';
import {
  snoozeConversation,
  unsnoozeConversation,
} from '../services/mailbox/snooze.js';
import { setCategory } from '../services/mailbox/category.js';
import {
  gtdClassify,
  gtdDone,
  gtdUnclassify,
} from '../services/gtd/actions.js';
import * as mailboxTools from './mailboxTools.js';
import { handleListFolders } from './mailboxTools.js';
import { HANDLERS, TOOL_DEFS, TOOL_SCOPES } from './tools.js';

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const scope = { userId: 'user-1', accountIds: [ACCOUNT_ID] };
const deps = { imapManager: { marker: 'imap' } };

beforeEach(() => {
  vi.clearAllMocks();
  getAccountRow.mockResolvedValue({ id: ACCOUNT_ID });
});

describe('mailbox tool definitions and registration', () => {
  it('registers list_folders as a read tool', () => {
    expect(TOOL_DEFS.map(def => def.name)).toContain('list_folders');
    expect(TOOL_SCOPES.list_folders).toBe('read');
    expect(HANDLERS.list_folders).toBeTypeOf('function');
  });

  it('registers all folder mutations with write scope', () => {
    const defs = new Map(TOOL_DEFS.map(def => [def.name, def]));
    for (const [name, required] of [
      ['create_folder', ['account', 'name']],
      ['rename_folder', ['account', 'path', 'new_name']],
      ['delete_folder', ['account', 'path', 'expected_message_count']],
    ]) {
      expect(defs.get(name)?.inputSchema.required).toEqual(required);
      expect(TOOL_SCOPES[name]).toBe('write');
      expect(HANDLERS[name]).toBeTypeOf('function');
    }
  });

  it('registers move_messages with explicit bulk ids and destination folder', () => {
    const def = TOOL_DEFS.find(entry => entry.name === 'move_messages');
    expect(def.inputSchema.required).toEqual(['message_ids', 'folder']);
    expect(def.inputSchema.properties.message_ids).toEqual({
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 500,
    });
    expect(def.inputSchema.properties).not.toHaveProperty('label');
    expect(TOOL_SCOPES.move_messages).toBe('write');
    expect(HANDLERS.move_messages).toBeTypeOf('function');
  });

  it('registers archive_messages and trash_messages without a delete_messages alias', () => {
    const defs = new Map(TOOL_DEFS.map(def => [def.name, def]));
    for (const name of ['archive_messages', 'trash_messages']) {
      expect(defs.get(name)?.inputSchema.required).toEqual(['message_ids']);
      expect(TOOL_SCOPES[name]).toBe('write');
      expect(HANDLERS[name]).toBeTypeOf('function');
    }
    expect(defs.has('delete_messages')).toBe(false);
    expect(HANDLERS).not.toHaveProperty('delete_messages');
  });

  it('registers all four message flag tools with explicit bulk ids and write scope', () => {
    const defs = new Map(TOOL_DEFS.map(def => [def.name, def]));
    for (const name of [
      'mark_read',
      'mark_unread',
      'star_message',
      'unstar_message',
    ]) {
      expect(defs.get(name)?.inputSchema.required).toEqual(['message_ids']);
      expect(defs.get(name)?.inputSchema.properties.message_ids).toEqual({
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 500,
      });
      expect(TOOL_SCOPES[name]).toBe('write');
      expect(HANDLERS[name]).toBeTypeOf('function');
    }
  });

  it('registers mark_spam and mark_not_spam with one explicit message id', () => {
    const defs = new Map(TOOL_DEFS.map(def => [def.name, def]));
    for (const name of ['mark_spam', 'mark_not_spam']) {
      expect(defs.get(name)?.inputSchema.required).toEqual(['message_id']);
      expect(defs.get(name)?.inputSchema.properties.message_id).toEqual({
        type: 'string',
      });
      expect(TOOL_SCOPES[name]).toBe('write');
      expect(HANDLERS[name]).toBeTypeOf('function');
    }
  });

  it('registers snooze_message and unsnooze_message with their explicit arguments', () => {
    const defs = new Map(TOOL_DEFS.map(def => [def.name, def]));
    expect(defs.get('snooze_message')?.inputSchema.required).toEqual([
      'message_id',
      'until',
    ]);
    expect(defs.get('unsnooze_message')?.inputSchema.required).toEqual([
      'message_id',
    ]);
    expect(
      defs.get('unsnooze_message')?.inputSchema.properties.mark_unread,
    ).toEqual({ type: 'boolean', default: false });
    for (const name of ['snooze_message', 'unsnooze_message']) {
      expect(TOOL_SCOPES[name]).toBe('write');
      expect(HANDLERS[name]).toBeTypeOf('function');
    }
  });

  it('registers set_category, gtd_classify, and gtd_done with write scope', () => {
    const defs = new Map(TOOL_DEFS.map(def => [def.name, def]));
    expect(defs.get('set_category')?.inputSchema.required).toEqual([
      'message_id',
      'category',
    ]);
    expect(defs.get('gtd_classify')?.inputSchema.required).toEqual([
      'message_id',
      'state',
    ]);
    expect(defs.get('gtd_done')?.inputSchema.required).toEqual(['message_id']);
    for (const name of ['set_category', 'gtd_classify', 'gtd_done']) {
      expect(TOOL_SCOPES[name]).toBe('write');
      expect(HANDLERS[name]).toBeTypeOf('function');
    }
  });
});

describe('mailbox tool metadata completeness', () => {
  const expected = {
    list_folders: [true, false, true, false],
    create_folder: [false, false, false, false],
    rename_folder: [false, true, false, false],
    delete_folder: [false, true, true, false],
    move_messages: [false, true, false, false],
    archive_messages: [false, false, true, false],
    trash_messages: [false, true, true, false],
    mark_read: [false, false, true, false],
    mark_unread: [false, false, true, false],
    star_message: [false, false, true, false],
    unstar_message: [false, false, true, false],
    mark_spam: [false, false, true, false],
    mark_not_spam: [false, false, true, false],
    snooze_message: [false, false, true, false],
    unsnooze_message: [false, false, true, false],
    set_category: [false, false, true, false],
    gtd_classify: [false, false, true, false],
    gtd_done: [false, false, true, false],
  };

  it('pins all 18 mailbox annotation rows from the protocol table', () => {
    const defs = new Map(TOOL_DEFS.map(def => [def.name, def]));
    expect(Object.keys(expected)).toHaveLength(18);
    for (const [name, [
      readOnlyHint,
      destructiveHint,
      idempotentHint,
      openWorldHint,
    ]] of Object.entries(expected)) {
      expect(defs.get(name)?.annotations).toEqual({
        readOnlyHint,
        destructiveHint,
        idempotentHint,
        openWorldHint,
      });
    }
  });

  it('gives every mailbox write definition a scope and four boolean hints', () => {
    const defs = new Map(TOOL_DEFS.map(def => [def.name, def]));
    for (const name of Object.keys(expected).filter(name => name !== 'list_folders')) {
      expect(TOOL_SCOPES[name]).toBe('write');
      const annotations = defs.get(name)?.annotations;
      expect(Object.keys(annotations || {}).sort()).toEqual([
        'destructiveHint',
        'idempotentHint',
        'openWorldHint',
        'readOnlyHint',
      ]);
      expect(Object.values(annotations).every(value => typeof value === 'boolean')).toBe(true);
    }
  });
});

describe('shared mailbox validators', () => {
  it('enforces explicit 1-500 UUID message_ids arrays', () => {
    expect(mailboxTools.messageIdsArg({})).toEqual({
      error: 'message_ids must contain at least one id',
    });
    expect(mailboxTools.messageIdsArg({ message_ids: [] })).toEqual({
      error: 'message_ids must contain at least one id',
    });
    expect(mailboxTools.messageIdsArg({
      message_ids: Array.from({ length: 501 }, () => ACCOUNT_ID),
    })).toEqual({ error: 'Too many ids — maximum 500 per request' });
    expect(mailboxTools.messageIdsArg({ message_ids: ['not-a-uuid'] })).toEqual({
      error: 'Invalid message id format',
    });
    expect(mailboxTools.messageIdsArg({ message_ids: [ACCOUNT_ID] })).toEqual({
      value: [ACCOUNT_ID],
    });
  });

  it('requires a single UUID message_id', () => {
    expect(mailboxTools.messageIdArg({})).toEqual({
      error: 'message_id parameter is required',
    });
    expect(mailboxTools.messageIdArg({ message_id: 'not-a-uuid' })).toEqual({
      error: 'Invalid message id format',
    });
    expect(mailboxTools.messageIdArg({ message_id: ACCOUNT_ID })).toEqual({
      value: ACCOUNT_ID,
    });
  });
});

describe('list_folders', () => {
  it('scope-checks the account and projects the curated folder shape', async () => {
    listFolders.mockResolvedValue({
      ok: true,
      folders: [{
        account_id: ACCOUNT_ID,
        path: 'INBOX',
        name: 'Inbox',
        delimiter: '/',
        special_use: '\\Inbox',
        total_count: 9,
        unread_count: 2,
        ignored_column: 'not-on-wire',
      }],
    });

    const result = await handleListFolders({ account: ACCOUNT_ID }, scope, deps);

    expect(JSON.parse(result.content[0].text)).toEqual({
      folders: [{
        path: 'INBOX',
        name: 'Inbox',
        delimiter: '/',
        special_use: '\\Inbox',
        total_count: 9,
        unread_count: 2,
        message_count: 9,
      }],
    });
    expect(getAccountRow).toHaveBeenCalledWith(ACCOUNT_ID, scope.accountIds);
    expect(listFolders).toHaveBeenCalledWith(deps.imapManager, {
      userId: scope.userId,
      accountIds: scope.accountIds,
      accountId: ACCOUNT_ID,
    });
  });

  it('rejects an out-of-scope account before calling the folder service', async () => {
    getAccountRow.mockResolvedValue(null);

    const result = await handleListFolders({ account: 'outside' }, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('account not found: outside');
    expect(listFolders).not.toHaveBeenCalled();
  });
});

describe('folder mutations', () => {
  it('creates a scoped folder and returns the resolved path', async () => {
    createFolder.mockResolvedValue({ ok: true, path: 'Projects/Client' });

    const result = await mailboxTools.handleCreateFolder({
      account: ACCOUNT_ID,
      name: 'Client',
      parent_path: 'Projects',
    }, scope, deps);

    expect(JSON.parse(result.content[0].text)).toEqual({
      ok: true,
      path: 'Projects/Client',
    });
    expect(createFolder).toHaveBeenCalledWith(deps.imapManager, {
      userId: scope.userId,
      accountIds: scope.accountIds,
      accountId: ACCOUNT_ID,
      name: 'Client',
      parentPath: 'Projects',
    });
  });

  it('rejects an invalid folder name before calling the service', async () => {
    const result = await mailboxTools.handleCreateFolder({
      account: ACCOUNT_ID,
      name: 'bad\u0000name',
    }, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Invalid folder name');
    expect(createFolder).not.toHaveBeenCalled();
  });

  it('renames the final folder component and names both paths in the receipt', async () => {
    renameFolder.mockResolvedValue({ ok: true, newPath: 'Projects/New' });

    const result = await mailboxTools.handleRenameFolder({
      account: ACCOUNT_ID,
      path: 'Projects/Old',
      new_name: 'New',
    }, scope, deps);

    expect(JSON.parse(result.content[0].text)).toEqual({
      ok: true,
      old_path: 'Projects/Old',
      new_path: 'Projects/New',
    });
    expect(renameFolder).toHaveBeenCalledWith(deps.imapManager, {
      userId: scope.userId,
      accountIds: scope.accountIds,
      accountId: ACCOUNT_ID,
      oldPath: 'Projects/Old',
      newName: 'New',
    });
  });

  it('refuses delete_folder when the live count differs from confirmation', async () => {
    listFolders.mockResolvedValue({
      ok: true,
      folders: [{ path: 'Projects', total_count: 7 }],
    });
    countMessagesIn.mockResolvedValue(7);

    const result = await mailboxTools.handleDeleteFolder({
      account: ACCOUNT_ID,
      path: 'Projects',
      expected_message_count: 3,
    }, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      'folder "Projects" holds 7 messages, not 3; re-check with list_folders and pass the current count to confirm',
    );
    expect(getAccountRow).toHaveBeenCalledWith(ACCOUNT_ID, scope.accountIds);
    expect(countMessagesIn).toHaveBeenCalledWith(ACCOUNT_ID, 'Projects');
    expect(deleteFolder).not.toHaveBeenCalled();
  });

  it('checks folder existence before reading its live count', async () => {
    listFolders.mockResolvedValue({ ok: true, folders: [] });

    const result = await mailboxTools.handleDeleteFolder({
      account: ACCOUNT_ID,
      path: 'Missing',
      expected_message_count: 0,
    }, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('folder not found: Missing');
    expect(countMessagesIn).not.toHaveBeenCalled();
    expect(deleteFolder).not.toHaveBeenCalled();
  });

  it('deletes only after the scope, existence, and count guards pass', async () => {
    listFolders.mockResolvedValue({
      ok: true,
      folders: [{ path: 'Projects', total_count: 2 }],
    });
    countMessagesIn.mockResolvedValue(2);
    deleteFolder.mockResolvedValue({ ok: true });

    const result = await mailboxTools.handleDeleteFolder({
      account: ACCOUNT_ID,
      path: 'Projects',
      expected_message_count: 2,
    }, scope, deps);

    expect(JSON.parse(result.content[0].text)).toEqual({
      ok: true,
      deleted: 'Projects',
      message_count: 2,
    });
    expect(deleteFolder).toHaveBeenCalledWith(deps.imapManager, {
      userId: scope.userId,
      accountIds: scope.accountIds,
      accountId: ACCOUNT_ID,
      path: 'Projects',
    });
  });
});

describe('move_messages', () => {
  const SECOND_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const NEW_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  it('rejects malformed ids before calling the move service', async () => {
    const result = await mailboxTools.handleMoveMessages({
      message_ids: ['not-a-uuid'],
      folder: 'Projects',
    }, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Invalid message id format');
    expect(bulkMoveToFolder).not.toHaveBeenCalled();
  });

  it('resolves UIDPLUS destination ids and reports non-UIDPLUS resyncs', async () => {
    bulkMoveToFolder.mockResolvedValue({
      ok: true,
      moved: [ACCOUNT_ID, SECOND_ID],
      movedDetails: [
        { id: ACCOUNT_ID, accountId: ACCOUNT_ID, uid: 110 },
        { id: SECOND_ID, accountId: ACCOUNT_ID, uid: null },
      ],
      failed: [],
      skippedAccounts: [],
    });
    resolveMovedIds.mockResolvedValue([{ id: NEW_ID, uid: 110 }]);

    const result = await mailboxTools.handleMoveMessages({
      message_ids: [ACCOUNT_ID, SECOND_ID],
      folder: 'Projects',
    }, scope, deps);

    expect(JSON.parse(result.content[0].text)).toEqual({
      ok: true,
      moved: [
        { id: ACCOUNT_ID, new_id: NEW_ID, uid: 110, folder: 'Projects' },
        { id: SECOND_ID, new_id: null, uid: null, folder: 'Projects' },
      ],
      failed: [],
      skipped_accounts: [],
      resync_pending: true,
      note: 'message ids change on move; use new_id for follow-up calls',
    });
    expect(bulkMoveToFolder).toHaveBeenCalledWith(deps.imapManager, {
      userId: scope.userId,
      accountIds: scope.accountIds,
      ids: [ACCOUNT_ID, SECOND_ID],
      folder: 'Projects',
    });
    expect(resolveMovedIds).toHaveBeenCalledWith(ACCOUNT_ID, 'Projects', [110]);
  });

  it('turns a fully skipped destination into an error', async () => {
    bulkMoveToFolder.mockResolvedValue({
      ok: true,
      moved: [],
      movedDetails: [],
      failed: [],
      skippedAccounts: [{
        account_id: ACCOUNT_ID,
        reason: 'folder_not_found',
      }],
    });

    const result = await mailboxTools.handleMoveMessages({
      message_ids: [ACCOUNT_ID],
      folder: 'Missing',
    }, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      `destination folder not found for account ${ACCOUNT_ID}: Missing`,
    );
    expect(resolveMovedIds).not.toHaveBeenCalled();
  });

  it('keeps failed and skipped partitions on a partial success receipt', async () => {
    bulkMoveToFolder.mockResolvedValue({
      ok: true,
      moved: [ACCOUNT_ID],
      movedDetails: [{ id: ACCOUNT_ID, accountId: ACCOUNT_ID, uid: 110 }],
      failed: [{ id: SECOND_ID, reason: 'IMAP move failed' }],
      skippedAccounts: [{ account_id: 'other-account', reason: 'folder_not_found' }],
    });
    resolveMovedIds.mockResolvedValue([{ id: NEW_ID, uid: 110 }]);

    const result = await mailboxTools.handleMoveMessages({
      message_ids: [ACCOUNT_ID, SECOND_ID],
      folder: 'Projects',
    }, scope, deps);

    const receipt = JSON.parse(result.content[0].text);
    expect(result.isError).toBeUndefined();
    expect(receipt.failed).toEqual([{ id: SECOND_ID, reason: 'IMAP move failed' }]);
    expect(receipt.skipped_accounts).toEqual([
      { account_id: 'other-account', reason: 'folder_not_found' },
    ]);
  });
});

describe('archive_messages', () => {
  const NEW_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const ALL_MAIL_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  it.each([
    [{}, 'message_ids must contain at least one id'],
    [{ message_ids: [] }, 'message_ids must contain at least one id'],
    [{
      message_ids: Array.from({ length: 501 }, () => ACCOUNT_ID),
    }, 'Too many ids — maximum 500 per request'],
    [{ message_ids: ['not-a-uuid'] }, 'Invalid message id format'],
  ])('rejects invalid explicit ids before calling the archive service', async (args, error) => {
    const result = await mailboxTools.handleArchiveMessages(args, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(error);
    expect(bulkArchive).not.toHaveBeenCalled();
  });

  it('returns durable ids and marks Gmail All Mail destinations as untracked', async () => {
    bulkArchive.mockResolvedValue({
      ok: true,
      archived: [ACCOUNT_ID, ALL_MAIL_ID],
      archivedDetails: [
        {
          id: ACCOUNT_ID,
          accountId: ACCOUNT_ID,
          folder: 'Archive',
          uid: 110,
          destinationUntracked: false,
        },
        {
          id: ALL_MAIL_ID,
          accountId: ACCOUNT_ID,
          folder: '[Gmail]/All Mail',
          uid: 111,
          destinationUntracked: true,
        },
      ],
      failed: [],
      noArchiveFolder: ['account-without-archive'],
    });
    resolveMovedIds.mockResolvedValue([{ id: NEW_ID, uid: 110 }]);

    const result = await mailboxTools.handleArchiveMessages({
      message_ids: [ACCOUNT_ID, ALL_MAIL_ID],
    }, scope, deps);

    expect(JSON.parse(result.content[0].text)).toEqual({
      ok: true,
      archived: [
        {
          id: ACCOUNT_ID,
          new_id: NEW_ID,
          uid: 110,
          folder: 'Archive',
          destination_untracked: false,
        },
        {
          id: ALL_MAIL_ID,
          new_id: null,
          uid: 111,
          folder: '[Gmail]/All Mail',
          destination_untracked: true,
        },
      ],
      failed: [],
      no_archive_folder: ['account-without-archive'],
      resync_pending: false,
      note: 'message ids change on archive; use new_id for follow-up calls',
    });
    expect(bulkArchive).toHaveBeenCalledWith(deps.imapManager, {
      userId: scope.userId,
      accountIds: scope.accountIds,
      ids: [ACCOUNT_ID, ALL_MAIL_ID],
    });
    expect(resolveMovedIds).toHaveBeenCalledWith(ACCOUNT_ID, 'Archive', [110]);
  });
});

describe('trash_messages', () => {
  const NEW_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  it.each([
    [{}, 'message_ids must contain at least one id'],
    [{ message_ids: [] }, 'message_ids must contain at least one id'],
    [{
      message_ids: Array.from({ length: 501 }, () => ACCOUNT_ID),
    }, 'Too many ids — maximum 500 per request'],
    [{ message_ids: ['not-a-uuid'] }, 'Invalid message id format'],
  ])('rejects invalid explicit ids before calling the trash service', async (args, error) => {
    const result = await mailboxTools.handleTrashMessages(args, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(error);
    expect(bulkTrash).not.toHaveBeenCalled();
  });

  it('never enables permanent deletion and preserves the refusal partition', async () => {
    bulkTrash.mockResolvedValue({
      ok: true,
      deleted: [ACCOUNT_ID],
      trashedDetails: [{
        id: ACCOUNT_ID,
        accountId: ACCOUNT_ID,
        folder: 'Trash',
        uid: 110,
      }],
      failed: [],
      refused: [{
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        folder: 'Trash',
        reason: 'already_in_trash_permanent_delete_required',
      }],
    });
    resolveMovedIds.mockResolvedValue([{ id: NEW_ID, uid: 110 }]);

    const result = await mailboxTools.handleTrashMessages({
      message_ids: [
        ACCOUNT_ID,
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      ],
    }, scope, deps);

    expect(JSON.parse(result.content[0].text)).toEqual({
      ok: true,
      trashed: [{
        id: ACCOUNT_ID,
        new_id: NEW_ID,
        folder: 'Trash',
      }],
      failed: [],
      refused: [{
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        folder: 'Trash',
        reason: 'already_in_trash_permanent_delete_required',
      }],
      resync_pending: false,
      next_step: 'use stage_deletion for permanent removal',
    });
    expect(bulkTrash).toHaveBeenCalledWith(deps.imapManager, {
      userId: scope.userId,
      accountIds: scope.accountIds,
      ids: [
        ACCOUNT_ID,
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      ],
      allowPermanent: false,
    });
  });
});

describe('mark_read and mark_unread', () => {
  it.each([
    ['handleMarkRead', true],
    ['handleMarkUnread', false],
  ])('returns only ids changed by %s', async (handlerName, read) => {
    bulkSetRead.mockResolvedValue({ ok: true, updated: [ACCOUNT_ID] });

    const result = await mailboxTools[handlerName]({
      message_ids: [ACCOUNT_ID],
    }, scope, deps);

    expect(JSON.parse(result.content[0].text)).toEqual({
      ok: true,
      updated: [ACCOUNT_ID],
    });
    expect(bulkSetRead).toHaveBeenCalledWith(deps.imapManager, {
      userId: scope.userId,
      accountIds: scope.accountIds,
      ids: [ACCOUNT_ID],
      read,
    });
  });
});

describe('star_message and unstar_message', () => {
  const SECOND_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it.each([
    ['handleStarMessage', true],
    ['handleUnstarMessage', false],
  ])('runs %s through bounded single-message writes and excludes no-ops', async (
    handlerName,
    starred,
  ) => {
    setStarred
      .mockResolvedValueOnce({ ok: true, is_starred: starred, updated: true })
      .mockResolvedValueOnce({ ok: true, is_starred: starred, updated: false });

    const result = await mailboxTools[handlerName]({
      message_ids: [ACCOUNT_ID, SECOND_ID],
    }, scope, deps);

    expect(JSON.parse(result.content[0].text)).toEqual({
      ok: true,
      updated: [ACCOUNT_ID],
    });
    expect(runInBatches).toHaveBeenCalledWith(
      [ACCOUNT_ID, SECOND_ID],
      3,
      expect.any(Function),
    );
    expect(setStarred).toHaveBeenNthCalledWith(1, deps.imapManager, {
      userId: scope.userId,
      accountIds: scope.accountIds,
      id: ACCOUNT_ID,
      starred,
    });
    expect(setStarred).toHaveBeenNthCalledWith(2, deps.imapManager, {
      userId: scope.userId,
      accountIds: scope.accountIds,
      id: SECOND_ID,
      starred,
    });
  });
});

describe.each([
  ['handleMarkRead', bulkSetRead],
  ['handleMarkUnread', bulkSetRead],
  ['handleStarMessage', setStarred],
  ['handleUnstarMessage', setStarred],
])('%s explicit-id validation', (handlerName, service) => {
  it.each([
    [{}, 'message_ids must contain at least one id'],
    [{ message_ids: [] }, 'message_ids must contain at least one id'],
    [{
      message_ids: Array.from({ length: 501 }, () => ACCOUNT_ID),
    }, 'Too many ids — maximum 500 per request'],
    [{ message_ids: ['not-a-uuid'] }, 'Invalid message id format'],
  ])('rejects invalid ids before any service call', async (args, error) => {
    const result = await mailboxTools[handlerName](args, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(error);
    expect(service).not.toHaveBeenCalled();
  });
});

describe('mark_spam and mark_not_spam', () => {
  it.each([
    ['handleMarkSpam', markSpam, 'Junk', 110],
    ['handleMarkNotSpam', markNotSpam, 'INBOX', null],
  ])('%s forwards scope and projects the destination receipt', async (
    handlerName,
    service,
    folder,
    newUid,
  ) => {
    service.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        ok: true,
        folder,
        newUid,
        alreadyInFolder: false,
      },
    });

    const result = await mailboxTools[handlerName]({
      message_id: ACCOUNT_ID,
    }, scope, deps);

    expect(JSON.parse(result.content[0].text)).toEqual({
      ok: true,
      folder,
      new_uid: newUid,
      already_in_folder: false,
    });
    expect(service).toHaveBeenCalledWith(deps.imapManager, {
      userId: scope.userId,
      accountIds: scope.accountIds,
      id: ACCOUNT_ID,
    });
  });

  it.each([
    ['handleMarkSpam', markSpam],
    ['handleMarkNotSpam', markNotSpam],
  ])('%s rejects a missing or malformed id before the service call', async (
    handlerName,
    service,
  ) => {
    for (const [args, error] of [
      [{}, 'message_id parameter is required'],
      [{ message_id: 'not-a-uuid' }, 'Invalid message id format'],
    ]) {
      const result = await mailboxTools[handlerName](args, scope, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(error);
    }
    expect(service).not.toHaveBeenCalled();
  });

  it('preserves a spam service refusal as an MCP error', async () => {
    markSpam.mockResolvedValue({
      ok: false,
      status: 422,
      error: 'No spam folder configured for this account',
    });

    const result = await mailboxTools.handleMarkSpam({
      message_id: ACCOUNT_ID,
    }, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      'No spam folder configured for this account',
    );
  });
});

describe('snooze_message', () => {
  it('reports the whole-conversation move count and sibling ids', async () => {
    const siblingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    snoozeConversation.mockResolvedValue({
      ok: true,
      movedCount: 2,
      movedIds: [ACCOUNT_ID, siblingId],
      folder: 'Snoozed',
    });
    const until = new Date(Date.now() + 60_000).toISOString();

    const result = await mailboxTools.handleSnoozeMessage({
      message_id: ACCOUNT_ID,
      until,
    }, scope, deps);

    expect(JSON.parse(result.content[0].text)).toEqual({
      ok: true,
      moved_count: 2,
      sibling_ids: [siblingId],
      folder: 'Snoozed',
    });
    expect(snoozeConversation).toHaveBeenCalledWith(deps.imapManager, {
      userId: scope.userId,
      accountIds: scope.accountIds,
      id: ACCOUNT_ID,
      until: new Date(until),
    });
  });

  it.each([
    [{ until: new Date(Date.now() + 60_000).toISOString() }, 'message_id parameter is required'],
    [{ message_id: 'not-a-uuid', until: new Date(Date.now() + 60_000).toISOString() }, 'Invalid message id format'],
    [{ message_id: ACCOUNT_ID }, 'until is required'],
    [{ message_id: ACCOUNT_ID, until: 'not-a-date' }, 'until must be a valid ISO date'],
    [{ message_id: ACCOUNT_ID, until: new Date(Date.now() - 60_000).toISOString() }, 'until must be in the future'],
    [{ message_id: ACCOUNT_ID, until: new Date(Date.now() + 31 * 86_400_000).toISOString() }, 'until must be within 30 days'],
  ])('rejects invalid arguments before calling the snooze service', async (args, error) => {
    const result = await mailboxTools.handleSnoozeMessage(args, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(error);
    expect(snoozeConversation).not.toHaveBeenCalled();
  });
});

describe('unsnooze_message', () => {
  it.each([
    [undefined, false],
    [true, true],
  ])('restores the conversation with mark_unread=%s', async (
    markUnreadArg,
    markUnread,
  ) => {
    unsnoozeConversation.mockResolvedValue({
      ok: true,
      restored: 2,
      folder: 'INBOX',
    });
    const args = { message_id: ACCOUNT_ID };
    if (markUnreadArg !== undefined) args.mark_unread = markUnreadArg;

    const result = await mailboxTools.handleUnsnoozeMessage(args, scope, deps);

    expect(JSON.parse(result.content[0].text)).toEqual({
      ok: true,
      restored: 2,
      folder: 'INBOX',
    });
    expect(unsnoozeConversation).toHaveBeenCalledWith(deps.imapManager, {
      userId: scope.userId,
      accountIds: scope.accountIds,
      id: ACCOUNT_ID,
      markUnread,
    });
  });

  it.each([
    [{}, 'message_id parameter is required'],
    [{ message_id: 'not-a-uuid' }, 'Invalid message id format'],
    [{ message_id: ACCOUNT_ID, mark_unread: 'yes' }, 'mark_unread must be a boolean'],
  ])('rejects invalid arguments before calling the unsnooze service', async (args, error) => {
    const result = await mailboxTools.handleUnsnoozeMessage(args, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(error);
    expect(unsnoozeConversation).not.toHaveBeenCalled();
  });
});

describe('set_category', () => {
  it('sets one validated category in the enabled-account scope', async () => {
    setCategory.mockResolvedValue({ ok: true, category: 'newsletter' });

    const result = await mailboxTools.handleSetCategory({
      message_id: ACCOUNT_ID,
      category: 'newsletter',
    }, scope, deps);

    expect(JSON.parse(result.content[0].text)).toEqual({
      ok: true,
      category: 'newsletter',
    });
    expect(setCategory).toHaveBeenCalledWith(deps.imapManager, {
      userId: scope.userId,
      accountIds: scope.accountIds,
      id: ACCOUNT_ID,
      category: 'newsletter',
    });
  });

  it.each([
    [{ category: 'primary' }, 'message_id parameter is required'],
    [{ message_id: 'not-a-uuid', category: 'primary' }, 'Invalid message id format'],
    [{ message_id: ACCOUNT_ID }, 'Invalid category'],
    [{ message_id: ACCOUNT_ID, category: 'other' }, 'Invalid category'],
  ])('rejects invalid arguments before the category service', async (args, error) => {
    const result = await mailboxTools.handleSetCategory(args, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(error);
    expect(setCategory).not.toHaveBeenCalled();
  });
});

describe('gtd_classify', () => {
  it.each([
    [false, gtdClassify, { ok: true, folder: 'Todo' }, {
      ok: true,
      state: 'todo',
      folder: 'Todo',
    }],
    [true, gtdUnclassify, {
      ok: true,
      removed: true,
      folder: 'Todo',
    }, {
      ok: true,
      state: 'todo',
      folder: 'Todo',
      removed: true,
    }],
  ])('dispatches remove=%s to the correct scoped GTD action', async (
    remove,
    service,
    serviceResult,
    receipt,
  ) => {
    service.mockResolvedValue(serviceResult);

    const result = await mailboxTools.handleGtdClassify({
      message_id: ACCOUNT_ID,
      state: 'todo',
      remove,
    }, scope, deps);

    expect(JSON.parse(result.content[0].text)).toEqual(receipt);
    expect(service).toHaveBeenCalledWith(deps.imapManager, {
      userId: scope.userId,
      accountIds: scope.accountIds,
      messageId: ACCOUNT_ID,
      state: 'todo',
    });
  });

  it.each([
    [{ state: 'todo' }, 'message_id parameter is required'],
    [{ message_id: 'not-a-uuid', state: 'todo' }, 'Invalid message id format'],
    [{ message_id: ACCOUNT_ID }, 'Unknown GTD state: undefined'],
    [{ message_id: ACCOUNT_ID, state: 'inbox' }, 'Unknown GTD state: inbox'],
    [{ message_id: ACCOUNT_ID, state: 'todo', remove: 'yes' }, 'remove must be a boolean'],
  ])('rejects invalid arguments before either GTD classify service', async (args, error) => {
    const result = await mailboxTools.handleGtdClassify(args, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(error);
    expect(gtdClassify).not.toHaveBeenCalled();
    expect(gtdUnclassify).not.toHaveBeenCalled();
  });
});

describe('gtd_done', () => {
  it('preserves archive failure as a non-error partial-success receipt', async () => {
    gtdDone.mockResolvedValue({
      ok: true,
      removed: ['Watch'],
      archived: false,
      noArchiveFolder: false,
      archiveFailed: true,
    });

    const result = await mailboxTools.handleGtdDone({
      message_id: ACCOUNT_ID,
      states: ['watch'],
    }, scope, deps);

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({
      ok: true,
      removed: ['Watch'],
      archived: false,
      no_archive_folder: false,
      archive_failed: true,
    });
    expect(gtdDone).toHaveBeenCalledWith(deps.imapManager, {
      userId: scope.userId,
      accountIds: scope.accountIds,
      id: ACCOUNT_ID,
      states: ['watch'],
    });
  });

  it('defaults omitted states to all', async () => {
    gtdDone.mockResolvedValue({
      ok: true,
      removed: [],
      archived: false,
      noArchiveFolder: true,
      archiveFailed: false,
    });

    await mailboxTools.handleGtdDone({ message_id: ACCOUNT_ID }, scope, deps);

    expect(gtdDone).toHaveBeenCalledWith(
      deps.imapManager,
      expect.objectContaining({ states: 'all' }),
    );
  });

  it.each([
    [{}, 'message_id parameter is required'],
    [{ message_id: 'not-a-uuid' }, 'Invalid message id format'],
    [{ message_id: ACCOUNT_ID, states: [] }, 'states must be a non-empty array'],
    [{ message_id: ACCOUNT_ID, states: ['inbox'] }, 'Unknown GTD state: inbox'],
  ])('rejects invalid arguments before gtd_done', async (args, error) => {
    const result = await mailboxTools.handleGtdDone(args, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(error);
    expect(gtdDone).not.toHaveBeenCalled();
  });
});

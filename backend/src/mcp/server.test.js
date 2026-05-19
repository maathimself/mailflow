import { describe, it, expect, vi, beforeEach } from 'vitest';

// registeredTools must be hoisted so it's available inside vi.mock factories
const { registeredTools } = vi.hoisted(() => {
  const registeredTools = new Map();
  return { registeredTools };
});

vi.mock('../services/emailSend.js', () => ({ sendEmail: vi.fn() }));
vi.mock('../services/messageQueries.js', () => ({
  listAccounts: vi.fn(),
  listFolders: vi.fn(),
  listMessages: vi.fn(),
  getUnreadCounts: vi.fn(),
  getMessage: vi.fn(),
  getThread: vi.fn(),
  searchMessages: vi.fn(),
}));
vi.mock('../services/mailActions.js', () => ({
  setMessageRead: vi.fn(),
  setMessageStarred: vi.fn(),
  moveSingleMessage: vi.fn(),
  deleteSingleMessage: vi.fn(),
  archiveSingleMessage: vi.fn(),
}));
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    tool(name, _desc, _schema, handler) {
      registeredTools.set(name, handler);
    }
  },
}));

import { sendEmail } from '../services/emailSend.js';
import {
  listAccounts, listFolders, listMessages, getUnreadCounts,
  getMessage, getThread, searchMessages,
} from '../services/messageQueries.js';
import {
  setMessageRead, setMessageStarred, moveSingleMessage,
  deleteSingleMessage, archiveSingleMessage,
} from '../services/mailActions.js';
import { createMcpServer } from './server.js';

const USER_ID = 'u1';
const imapManager = { syncNow: vi.fn().mockResolvedValue(undefined) };

beforeEach(() => {
  vi.clearAllMocks();
  registeredTools.clear();
  createMcpServer(USER_ID, imapManager);
});

function invoke(name, args) {
  const handler = registeredTools.get(name);
  if (!handler) throw new Error(`Tool '${name}' not registered`);
  return handler(args);
}

// ── Tool registration ─────────────────────────────────────────────────────────

describe('tool registration', () => {
  const expectedTools = [
    'list_accounts', 'list_folders', 'list_messages', 'get_message',
    'get_thread', 'search_messages', 'mark_read', 'mark_starred',
    'move_message', 'send_email', 'reply_to_message', 'sync',
    'get_unread_counts', 'delete_message', 'archive_message', 'forward_email',
  ];

  it.each(expectedTools)('registers %s tool', name => {
    expect(registeredTools.has(name)).toBe(true);
  });

  it('registers exactly 16 tools', () => {
    expect(registeredTools.size).toBe(16);
  });
});

// ── Delegation to service functions ──────────────────────────────────────────

describe('list_accounts', () => {
  it('delegates to listAccounts with userId', async () => {
    listAccounts.mockResolvedValueOnce([{ id: 'acc1' }]);
    const result = await invoke('list_accounts', {});
    expect(listAccounts).toHaveBeenCalledWith(USER_ID);
    expect(result.content[0].text).toContain('acc1');
  });
});

describe('list_folders', () => {
  it('passes account_id to listFolders', async () => {
    listFolders.mockResolvedValueOnce([]);
    await invoke('list_folders', { account_id: 'acc1' });
    expect(listFolders).toHaveBeenCalledWith(USER_ID, 'acc1');
  });
});

describe('list_messages', () => {
  it('passes all params to listMessages', async () => {
    listMessages.mockResolvedValueOnce([]);
    await invoke('list_messages', {
      account_id: 'acc1', folder: 'INBOX', unread_only: true, limit: 10, offset: 5,
    });
    expect(listMessages).toHaveBeenCalledWith(USER_ID, {
      accountId: 'acc1', folder: 'INBOX', unreadOnly: true, limit: 10, offset: 5,
    });
  });
});

describe('get_message', () => {
  it('returns "Message not found" when getMessage returns null', async () => {
    getMessage.mockResolvedValueOnce(null);
    const result = await invoke('get_message', { id: 'missing' });
    expect(result.content[0].text).toBe('Message not found');
  });

  it('returns message data when found', async () => {
    getMessage.mockResolvedValueOnce({ id: 'm1', subject: 'Hello' });
    const result = await invoke('get_message', { id: 'm1' });
    expect(result.content[0].text).toContain('Hello');
  });
});

describe('get_thread', () => {
  it('delegates to getThread', async () => {
    getThread.mockResolvedValueOnce([{ id: 'm1' }]);
    await invoke('get_thread', { thread_id: 't1' });
    expect(getThread).toHaveBeenCalledWith('t1', USER_ID);
  });
});

describe('search_messages', () => {
  it('passes query and options to searchMessages', async () => {
    searchMessages.mockResolvedValueOnce([]);
    await invoke('search_messages', { q: 'invoice', account_id: 'acc1', limit: 5 });
    expect(searchMessages).toHaveBeenCalledWith(USER_ID, 'invoice', { accountId: 'acc1', limit: 5 });
  });
});

describe('mark_read', () => {
  it('delegates to setMessageRead', async () => {
    setMessageRead.mockResolvedValueOnce({ ok: true, is_read: true });
    await invoke('mark_read', { id: 'm1', read: true });
    expect(setMessageRead).toHaveBeenCalledWith('m1', USER_ID, true, imapManager);
  });

  it('returns error message on failure', async () => {
    setMessageRead.mockRejectedValueOnce(new Error('Not found'));
    const result = await invoke('mark_read', { id: 'bad', read: true });
    expect(result.content[0].text).toBe('Not found');
  });
});

describe('mark_starred', () => {
  it('delegates to setMessageStarred', async () => {
    setMessageStarred.mockResolvedValueOnce({ ok: true, is_starred: true });
    await invoke('mark_starred', { id: 'm1', starred: true });
    expect(setMessageStarred).toHaveBeenCalledWith('m1', USER_ID, true, imapManager);
  });
});

describe('move_message', () => {
  it('delegates to moveSingleMessage', async () => {
    moveSingleMessage.mockResolvedValueOnce({ ok: true });
    await invoke('move_message', { id: 'm1', to_folder: 'Archive' });
    expect(moveSingleMessage).toHaveBeenCalledWith('m1', USER_ID, 'Archive', imapManager);
  });

  it('returns error message on failure', async () => {
    moveSingleMessage.mockRejectedValueOnce(new Error('IMAP error'));
    const result = await invoke('move_message', { id: 'm1', to_folder: 'Archive' });
    expect(result.content[0].text).toContain('Move failed: IMAP error');
  });
});

describe('delete_message', () => {
  it('delegates to deleteSingleMessage', async () => {
    deleteSingleMessage.mockResolvedValueOnce({ ok: true });
    await invoke('delete_message', { id: 'm1' });
    expect(deleteSingleMessage).toHaveBeenCalledWith('m1', USER_ID, imapManager);
  });
});

describe('archive_message', () => {
  it('delegates to archiveSingleMessage and returns archiveFolder', async () => {
    archiveSingleMessage.mockResolvedValueOnce({ ok: true, archiveFolder: 'Archive' });
    const result = await invoke('archive_message', { id: 'm1' });
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true, archived_to: 'Archive' });
  });
});

describe('get_unread_counts', () => {
  it('returns total_unread sum', async () => {
    getUnreadCounts.mockResolvedValueOnce([{ unread_count: 3 }, { unread_count: 7 }]);
    const result = await invoke('get_unread_counts', {});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total_unread).toBe(10);
  });
});

describe('sync', () => {
  it('calls syncNow and returns ok immediately', async () => {
    const result = await invoke('sync', { account_id: 'acc1' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(imapManager.syncNow).toHaveBeenCalledWith(USER_ID, 'acc1');
  });

  it('passes null when no account_id provided', async () => {
    await invoke('sync', {});
    expect(imapManager.syncNow).toHaveBeenCalledWith(USER_ID, null);
  });
});

describe('send_email', () => {
  it('delegates to sendEmail with split recipients', async () => {
    sendEmail.mockResolvedValueOnce(undefined);
    await invoke('send_email', {
      account_id: 'acc1', to: 'a@b.com,c@d.com', subject: 'Test', body: 'Hi',
    });
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc1',
        to: ['a@b.com', 'c@d.com'],
        subject: 'Test',
        body: 'Hi',
      }),
      USER_ID,
      imapManager
    );
  });

  it('returns error message on failure', async () => {
    sendEmail.mockRejectedValueOnce(new Error('SMTP down'));
    const result = await invoke('send_email', {
      account_id: 'acc1', to: 'a@b.com', subject: 'Hi', body: 'Hello',
    });
    expect(result.content[0].text).toContain('Send failed: SMTP down');
  });
});

describe('reply_to_message', () => {
  it('returns not found when message is missing', async () => {
    getMessage.mockResolvedValueOnce(null);
    const result = await invoke('reply_to_message', { id: 'bad', body: 'Hi', reply_all: false });
    expect(result.content[0].text).toBe('Message not found');
  });

  it('calls sendEmail with inReplyTo and quoted body', async () => {
    getMessage.mockResolvedValueOnce({
      id: 'm1', account_id: 'acc1', subject: 'Hello', from_email: 'them@x.com',
      from_name: 'Them', reply_to: null, message_id: '<msg@x.com>',
      to_addresses: [], cc_addresses: [], account_email: 'me@x.com',
      date: '2024-01-01T10:00:00Z', body_text: 'Original message',
    });
    sendEmail.mockResolvedValueOnce(undefined);
    await invoke('reply_to_message', { id: 'm1', body: 'Thanks!', reply_all: false });
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc1',
        to: ['them@x.com'],
        inReplyTo: '<msg@x.com>',
        subject: 'Re: Hello',
      }),
      USER_ID,
      imapManager
    );
  });
});

describe('forward_email', () => {
  it('returns not found when message is missing', async () => {
    getMessage.mockResolvedValueOnce(null);
    const result = await invoke('forward_email', { id: 'bad', to: 'a@b.com' });
    expect(result.content[0].text).toBe('Message not found');
  });

  it('calls sendEmail with Fwd subject and forwarded body', async () => {
    getMessage.mockResolvedValueOnce({
      id: 'm1', account_id: 'acc1', subject: 'Original', from_email: 'them@x.com',
      from_name: 'Them', date: '2024-01-01T10:00:00Z', body_text: 'Original body',
    });
    sendEmail.mockResolvedValueOnce(undefined);
    await invoke('forward_email', { id: 'm1', to: 'fwd@y.com', note: 'See below' });
    const call = sendEmail.mock.calls[0][0];
    expect(call.subject).toBe('Fwd: Original');
    expect(call.body).toBe('See below');
    expect(call.quotedBody).toContain('Forwarded message');
    expect(call.quotedBody).toContain('Original body');
  });
});

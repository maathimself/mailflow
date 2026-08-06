import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./gtdConfig.js', () => ({
  getGtdConfig: vi.fn(),
  resolveGtdStateFolder: vi.fn((_state, folders) => folders.delegated),
}));

import { query } from './db.js';
import { getGtdConfig } from './gtdConfig.js';
import {
  delegateMessages,
  delegationJoinSql,
  loadOwnedContactSnapshot,
  mapDelegationRow,
  reconcileDelegatedRemovals,
  sweepStaleDelegations,
  upsertDelegation,
} from './gtdDelegations.js';

const USER = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const MESSAGE_A = '33333333-3333-4333-8333-333333333333';
const MESSAGE_B = '44444444-4444-4444-8444-444444444444';
const CONTACT = '55555555-5555-4555-8555-555555555555';
const contact = { id: CONTACT, display_name: 'Casey Rivera', primary_email: 'casey@example.test' };
const row = id => ({
  id, account_id: ACCOUNT, uid: id === MESSAGE_A ? 10 : 11, folder: 'INBOX',
  message_id: `<${id}@example.test>`, thread_key: 'thread@example.test',
});

const imapManager = () => ({
  ensureFolder: vi.fn(), copyMessage: vi.fn().mockResolvedValue(77),
  removeMessageCopy: vi.fn(), syncFolderOnDemand: vi.fn(),
});

function stubSuccess({ messages = [row(MESSAGE_A)], existing = false, insertError = null } = {}) {
  query.mockImplementation(async sql => {
    if (sql.includes('FROM contacts c')) return { rows: [contact] };
    if (sql.includes('FROM messages m') && sql.includes('ANY($2::uuid[])')) return { rows: messages };
    if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [{ id: ACCOUNT, user_id: USER }] };
    if (sql.includes('SELECT uid FROM messages')) return { rows: existing ? [{ uid: 88 }] : [] };
    if (sql.includes('INSERT INTO gtd_delegations')) {
      if (insertError) throw insertError;
      return { rows: [{ contact_id: CONTACT, display_name: contact.display_name, primary_email: contact.primary_email }] };
    }
    if (sql.includes('DELETE FROM gtd_delegations')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
}

beforeEach(() => {
  query.mockReset();
  getGtdConfig.mockReset();
  getGtdConfig.mockResolvedValue({ enabled: true, folders: { delegated: 'Delegated' } });
});

describe('delegation persistence primitives', () => {
  it('rejects a contact owned by another user without exposing it', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(loadOwnedContactSnapshot(USER, CONTACT))
      .rejects.toMatchObject({ code: 'contact_not_found', status: 404 });
  });

  it('resets the age anchor only when the contact changes', async () => {
    query.mockResolvedValueOnce({ rows: [contact] });
    await upsertDelegation({ userId: USER, accountId: ACCOUNT, threadKey: 'thread', contact });
    expect(query.mock.calls[0][0]).toContain('contact_id IS DISTINCT FROM EXCLUDED.contact_id');
    expect(query.mock.calls[0][0]).toContain('THEN NOW()');
    expect(query.mock.calls[0][0]).toContain('updated_at = NOW()');
  });

  it('maps JSON and validates reusable join aliases', () => {
    expect(mapDelegationRow({ delegation: '{"contact_id":null}' })).toEqual({ contact_id: null });
    expect(delegationJoinSql('m', 'a')).toContain('gd.user_id = a.user_id');
    expect(() => delegationJoinSql('m;drop', 'a')).toThrow(TypeError);
  });
});

describe('delegateMessages', () => {
  it('normalizes duplicate IDs and performs one copy for one logical thread', async () => {
    stubSuccess({ messages: [row(MESSAGE_A), row(MESSAGE_B)] });
    const imap = imapManager();
    const result = await delegateMessages({
      userId: USER, messageIds: [MESSAGE_A, MESSAGE_A, MESSAGE_B], contactId: CONTACT, imapManager: imap,
    });
    expect(result).toMatchObject({ status: 'success', successCount: 2, failureCount: 0 });
    expect(result.results.map(item => item.messageId)).toEqual([MESSAGE_A, MESSAGE_B]);
    expect(imap.copyMessage).toHaveBeenCalledTimes(1);
  });

  it('clears a previous person when contactId is null while retaining the label', async () => {
    stubSuccess({ existing: true });
    const result = await delegateMessages({
      userId: USER, messageIds: [MESSAGE_A], contactId: null, imapManager: imapManager(),
    });
    expect(result.results[0]).toMatchObject({ ok: true, delegation: null });
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM gtd_delegations'))).toBe(true);
  });

  it('removes a newly copied label when persistence fails', async () => {
    stubSuccess({ insertError: new Error('write failed') });
    const imap = imapManager();
    const result = await delegateMessages({
      userId: USER, messageIds: [MESSAGE_A], contactId: CONTACT, imapManager: imap,
    });
    expect(imap.removeMessageCopy).toHaveBeenCalledWith(ACCOUNT, 77, 'Delegated');
    expect(result.results[0]).toMatchObject({ ok: false, compensated: true });
  });

  it('does not remove a pre-existing delegated label when persistence fails', async () => {
    stubSuccess({ existing: true, insertError: new Error('write failed') });
    const imap = imapManager();
    await delegateMessages({ userId: USER, messageIds: [MESSAGE_A], contactId: CONTACT, imapManager: imap });
    expect(imap.removeMessageCopy).not.toHaveBeenCalled();
  });

  it('serializes simultaneous requests for one thread so only one remote copy is made', async () => {
    let copied = false;
    query.mockImplementation(async sql => {
      if (sql.includes('FROM contacts c')) return { rows: [contact] };
      if (sql.includes('FROM messages m') && sql.includes('ANY($2::uuid[])')) return { rows: [row(MESSAGE_A)] };
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [{ id: ACCOUNT, user_id: USER }] };
      if (sql.includes('SELECT uid FROM messages')) return { rows: copied ? [{ uid: 77 }] : [] };
      if (sql.includes('INSERT INTO gtd_delegations')) return { rows: [contact] };
      return { rows: [], rowCount: 0 };
    });
    const imap = imapManager();
    imap.copyMessage.mockImplementation(async () => { copied = true; return 77; });

    const [first, retry] = await Promise.all([
      delegateMessages({ userId: USER, messageIds: [MESSAGE_A], contactId: CONTACT, imapManager: imap }),
      delegateMessages({ userId: USER, messageIds: [MESSAGE_A], contactId: CONTACT, imapManager: imap }),
    ]);

    expect(first.status).toBe('success');
    expect(retry.status).toBe('success');
    expect(imap.copyMessage).toHaveBeenCalledTimes(1);
  });

  it('awaits non-UIDPLUS destination reconciliation before reporting success', async () => {
    let syncCount = 0;
    query.mockImplementation(async sql => {
      if (sql.includes('FROM contacts c')) return { rows: [contact] };
      if (sql.includes('FROM messages m') && sql.includes('ANY($2::uuid[])')) return { rows: [row(MESSAGE_A)] };
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [{ id: ACCOUNT, user_id: USER }] };
      if (sql.includes('SELECT uid FROM messages')) return { rows: syncCount >= 2 ? [{ uid: 91 }] : [] };
      if (sql.includes('INSERT INTO gtd_delegations')) return { rows: [contact] };
      return { rows: [], rowCount: 0 };
    });
    const imap = imapManager();
    imap.copyMessage.mockResolvedValue(null);
    imap.syncFolderOnDemand.mockImplementation(async () => { syncCount += 1; });

    const result = await delegateMessages({
      userId: USER, messageIds: [MESSAGE_A], contactId: CONTACT, imapManager: imap,
    });

    expect(result.status).toBe('success');
    expect(imap.syncFolderOnDemand).toHaveBeenCalledTimes(2);
  });

  it('compensates the exact UID when COPY succeeds remotely but local completion throws', async () => {
    query.mockImplementation(async sql => {
      if (sql.includes('FROM contacts c')) return { rows: [contact] };
      if (sql.includes('FROM messages m') && sql.includes('ANY($2::uuid[])')) return { rows: [row(MESSAGE_A)] };
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [{ id: ACCOUNT, user_id: USER }] };
      if (sql.includes('SELECT uid FROM messages')) return { rows: [] };
      return { rows: [], rowCount: 0 };
    });
    const imap = imapManager();
    imap.copyMessage.mockImplementation(async () => {
      const error = new Error('local sibling insert failed');
      error.copiedUid = 93;
      throw error;
    });

    const result = await delegateMessages({
      userId: USER, messageIds: [MESSAGE_A], contactId: CONTACT, imapManager: imap,
    });

    expect(imap.removeMessageCopy).toHaveBeenCalledWith(ACCOUNT, 93, 'Delegated');
    expect(result.results[0]).toMatchObject({ ok: false, compensated: true });
  });

  it('does not guess at compensation when an ambiguous COPY failure has no exact UID', async () => {
    stubSuccess();
    const imap = imapManager();
    imap.copyMessage.mockRejectedValue(new Error('connection lost after COPY'));

    const result = await delegateMessages({
      userId: USER, messageIds: [MESSAGE_A], contactId: CONTACT, imapManager: imap,
    });

    expect(imap.removeMessageCopy).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({ ok: false, compensated: false });
  });

  it('rejects more than 100 IDs before querying', async () => {
    const ids = Array.from({ length: 101 }, (_, index) => `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`);
    await expect(delegateMessages({ userId: USER, messageIds: ids, contactId: null, imapManager: imapManager() }))
      .rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    expect(query).not.toHaveBeenCalled();
  });
});

it('reconciles only delegation rows without a surviving folder copy', async () => {
  query.mockResolvedValueOnce({ rowCount: 2, rows: [] });
  await expect(reconcileDelegatedRemovals({
    userId: USER, accountId: ACCOUNT, delegatedFolder: 'Delegated', threadKeys: ['a', 'a', 'b'],
  })).resolves.toBe(2);
  expect(query.mock.calls[0][1]).toEqual([USER, ACCOUNT, ['a', 'b'], 'Delegated']);
  expect(query.mock.calls[0][0]).toContain('NOT EXISTS');
});

it('sweeps stale rows even when the original removed thread is no longer available', async () => {
  query.mockResolvedValueOnce({ rowCount: 3, rows: [] });
  await expect(sweepStaleDelegations({
    userId: USER, accountId: ACCOUNT, delegatedFolder: 'Delegated',
  })).resolves.toBe(3);
  expect(query.mock.calls[0][1]).toEqual([USER, ACCOUNT, 'Delegated']);
  expect(query.mock.calls[0][0]).toContain('NOT EXISTS');
  expect(query.mock.calls[0][0]).not.toContain('ANY(');
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./identitySync.js', () => ({ syncAccountIdentities: vi.fn() }));

const { query } = await import('./db.js');
const { syncAccountIdentities } = await import('./identitySync.js');
const { resolveReplySender } = await import('./replySender.js');

const USER_ID = 'user-1';
const MESSAGE_ID = 'msg-1';
const ACCOUNT_ID = 'acct-1';

function messageRow(overrides = {}) {
  return {
    account_id: ACCOUNT_ID,
    delivery_addresses: [],
    to_addresses: [],
    cc_addresses: [],
    account_email: 'me@example.com',
    jmap_api_token: null,
    jmap_identity_sync_at: new Date().toISOString(),
    ...overrides,
  };
}

// Queries fire in a fixed order: message+account join, alias emails, sendable_addresses
// (and, on a stale-sync miss, sendable_addresses again after the resync).
function stub({ message, aliases = [], sendable = [], sendableAfterSync }) {
  query.mockReset();
  const calls = [];
  query.mockImplementation(async (sql) => {
    calls.push(sql);
    if (sql.includes('FROM messages m')) return { rows: message ? [message] : [] };
    if (sql.startsWith('SELECT email FROM account_aliases')) return { rows: aliases.map(email => ({ email })) };
    if (sql.includes('FROM sendable_addresses')) {
      const isSecondCall = calls.filter(s => s.includes('FROM sendable_addresses')).length > 1;
      return { rows: (isSecondCall && sendableAfterSync !== undefined) ? sendableAfterSync : sendable };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  syncAccountIdentities.mockReset();
});

describe('resolveReplySender — ownership', () => {
  it('throws a 404 when the message is not owned by the user', async () => {
    stub({ message: null });

    await expect(resolveReplySender({ messageId: MESSAGE_ID, userId: USER_ID }))
      .rejects.toMatchObject({ status: 404 });
  });
});

describe('resolveReplySender — matching', () => {
  it('matches a delivery address', async () => {
    stub({
      message: messageRow({ delivery_addresses: ['sales@example.com'] }),
      sendable: [{ address: 'sales@example.com', name: 'Sales' }],
    });

    const result = await resolveReplySender({ messageId: MESSAGE_ID, userId: USER_ID });

    expect(result).toEqual({ sender: { fromEmail: 'sales@example.com', name: 'Sales' } });
  });

  it('matches a wildcard identity covering a delivered-to candidate', async () => {
    stub({
      message: messageRow({ delivery_addresses: ['random@example.com'] }),
      sendable: [{ address: '*@example.com', name: 'Catch-all' }],
    });

    const result = await resolveReplySender({ messageId: MESSAGE_ID, userId: USER_ID });

    expect(result).toEqual({ sender: { fromEmail: 'random@example.com', name: 'Catch-all' } });
  });

  // Seam proof: a Masked Email address (kind='masked') must resolve exactly like a
  // synced identity (kind='identity') — the sendable_addresses lookup must never filter on
  // `kind`.
  it('matches a Masked Email-sourced row the same as an identity row', async () => {
    stub({
      message: messageRow({ delivery_addresses: ['random1@fastmail.example'] }),
      sendable: [{ address: 'random1@fastmail.example', name: 'Private address' }],
    });

    const result = await resolveReplySender({ messageId: MESSAGE_ID, userId: USER_ID });

    expect(result).toEqual({ sender: { fromEmail: 'random1@fastmail.example', name: 'Private address' } });
    const sendableQuery = query.mock.calls.find(c => c[0].includes('FROM sendable_addresses'));
    expect(sendableQuery[0]).not.toMatch(/kind\s*=/);
  });

  it('prefers delivery address over a different To match', async () => {
    stub({
      message: messageRow({
        delivery_addresses: ['sales@example.com'],
        to_addresses: [{ email: 'support@example.com' }],
      }),
      sendable: [
        { address: 'sales@example.com', name: 'Sales' },
        { address: 'support@example.com', name: 'Support' },
      ],
    });

    const result = await resolveReplySender({ messageId: MESSAGE_ID, userId: USER_ID });

    expect(result.sender.fromEmail).toBe('sales@example.com');
  });

  it('falls back to Cc when there is no delivery or To match', async () => {
    stub({
      message: messageRow({ cc_addresses: [{ email: 'support@example.com' }] }),
      sendable: [{ address: 'support@example.com', name: 'Support' }],
    });

    const result = await resolveReplySender({ messageId: MESSAGE_ID, userId: USER_ID });

    expect(result.sender.fromEmail).toBe('support@example.com');
  });

  it('skips a candidate equal to the account primary address', async () => {
    stub({
      message: messageRow({ delivery_addresses: ['me@example.com'] }),
      sendable: [{ address: 'me@example.com', name: 'Me' }],
    });

    const result = await resolveReplySender({ messageId: MESSAGE_ID, userId: USER_ID });

    expect(result).toEqual({ sender: null });
  });

  it('skips a candidate that is already a saved alias', async () => {
    stub({
      message: messageRow({ delivery_addresses: ['alias@example.com'] }),
      aliases: ['alias@example.com'],
      sendable: [{ address: 'alias@example.com', name: 'Alias' }],
    });

    const result = await resolveReplySender({ messageId: MESSAGE_ID, userId: USER_ID });

    expect(result).toEqual({ sender: null });
  });

  it('returns a null sender on a clean miss (no candidates)', async () => {
    stub({ message: messageRow() });

    const result = await resolveReplySender({ messageId: MESSAGE_ID, userId: USER_ID });

    expect(result).toEqual({ sender: null });
  });

  it('never returns more than the single matched sender (no address enumeration)', async () => {
    stub({
      message: messageRow({ delivery_addresses: ['sales@example.com'] }),
      sendable: [
        { address: 'sales@example.com', name: 'Sales' },
        { address: 'support@example.com', name: 'Support' },
      ],
    });

    const result = await resolveReplySender({ messageId: MESSAGE_ID, userId: USER_ID });

    expect(Object.keys(result)).toEqual(['sender']);
    expect(Object.keys(result.sender).sort()).toEqual(['fromEmail', 'name']);
  });
});

describe('resolveReplySender — sync-on-miss', () => {
  it('re-syncs once on a miss when the token is configured and the sync is stale, then re-matches', async () => {
    const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    stub({
      message: messageRow({ delivery_addresses: ['new@example.com'], jmap_api_token: 'enc:token', jmap_identity_sync_at: stale }),
      sendable: [],
      sendableAfterSync: [{ address: 'new@example.com', name: 'New' }],
    });
    syncAccountIdentities.mockResolvedValue({ syncedAt: new Date() });

    const result = await resolveReplySender({ messageId: MESSAGE_ID, userId: USER_ID });

    expect(syncAccountIdentities).toHaveBeenCalledOnce();
    expect(syncAccountIdentities).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(result).toEqual({ sender: { fromEmail: 'new@example.com', name: 'New' } });
  });

  it('does not re-sync when the last sync is recent (not stale)', async () => {
    stub({
      message: messageRow({ delivery_addresses: ['new@example.com'], jmap_api_token: 'enc:token' }),
      sendable: [],
    });

    const result = await resolveReplySender({ messageId: MESSAGE_ID, userId: USER_ID });

    expect(syncAccountIdentities).not.toHaveBeenCalled();
    expect(result).toEqual({ sender: null });
  });

  it('does not re-sync when no token is configured, even if stale/never synced', async () => {
    stub({
      message: messageRow({ delivery_addresses: ['new@example.com'], jmap_api_token: null, jmap_identity_sync_at: null }),
      sendable: [],
    });

    const result = await resolveReplySender({ messageId: MESSAGE_ID, userId: USER_ID });

    expect(syncAccountIdentities).not.toHaveBeenCalled();
    expect(result).toEqual({ sender: null });
  });

  it('swallows a sync failure into a null sender', async () => {
    const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    stub({
      message: messageRow({ delivery_addresses: ['new@example.com'], jmap_api_token: 'enc:token', jmap_identity_sync_at: stale }),
      sendable: [],
    });
    syncAccountIdentities.mockRejectedValue(Object.assign(new Error('bad token'), { code: 'JMAP_CONFIG' }));

    const result = await resolveReplySender({ messageId: MESSAGE_ID, userId: USER_ID });

    expect(result).toEqual({ sender: null });
  });
});

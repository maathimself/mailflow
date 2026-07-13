import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./fastmailAliasSync.js', () => ({ syncFastmailAliases: vi.fn() }));

import { query } from './db.js';
import { syncFastmailAliases } from './fastmailAliasSync.js';
import { matchAuthorizedSender, resolveMessageSender } from './senderResolver.js';

const account = {
  id: 'a1',
  email_address: 'owner@example.com',
  sender_name: 'Account Owner',
  name: 'Fastmail',
  fastmail_api_token: 'encrypted-token',
};

const aliases = [
  {
    id: 'provider', account_id: 'a1', name: 'Provider Alias', email: 'alias@example.com',
    provenance: 'fastmail', fastmail_identity_id: 'i1',
  },
  {
    id: 'manual', account_id: 'a1', name: 'Manual Alias', email: 'alias@example.com',
    provenance: 'manual', fastmail_identity_id: null,
  },
  {
    id: 'wild', account_id: 'a1', name: 'Wildcard', email: '*@example.net',
    provenance: 'fastmail', fastmail_identity_id: 'i2',
  },
];

describe('matchAuthorizedSender', () => {
  it('prefers the first delivered candidate over visible To and Cc recipients', () => {
    const result = matchAuthorizedSender({
      account,
      aliases,
      candidates: ['Mask@Example.net', 'alias@example.com'],
    });

    expect(result).toMatchObject({
      accountId: 'a1', aliasId: 'wild', fromEmail: 'mask@example.net',
      displayEmail: 'mask@example.net', provenance: 'fastmail',
    });
  });

  it('prefers provider exact over manual exact for the same candidate', () => {
    expect(matchAuthorizedSender({ account, aliases, candidates: ['ALIAS@example.com'] }))
      .toMatchObject({ aliasId: 'provider', fromEmail: null, displayEmail: 'alias@example.com' });
  });

  it('preserves a blank Fastmail identity name instead of borrowing the account name', () => {
    const blankNameAlias = { ...aliases[0], name: '' };

    expect(matchAuthorizedSender({
      account,
      aliases: [blankNameAlias],
      candidates: ['alias@example.com'],
    })).toMatchObject({
      aliasId: 'provider',
      displayEmail: 'alias@example.com',
      name: '',
    });
  });

  it('returns the effective alias signature for a resolved sender', () => {
    const alias = { ...aliases[0], signature: '<p>Alias signature</p>' };

    expect(matchAuthorizedSender({
      account: { ...account, signature: '<p>Account signature</p>' },
      aliases: [alias],
      candidates: ['alias@example.com'],
    })).toMatchObject({
      aliasId: 'provider',
      signature: '<p>Alias signature</p>',
    });
  });

  it('preserves an explicitly blank provider signature in the resolved sender', () => {
    const alias = { ...aliases[0], signature: '' };

    expect(matchAuthorizedSender({
      account: { ...account, signature: '<p>Account signature</p>' },
      aliases: [alias],
      candidates: ['alias@example.com'],
    })).toMatchObject({ signature: '' });
  });

  it.each([
    ['manual exact', [aliases[1]], 'ALIAS@example.com', { aliasId: 'manual', provenance: 'manual' }],
    ['primary account', aliases, 'OWNER@EXAMPLE.COM', { aliasId: null, provenance: 'primary' }],
    ['verified wildcard', aliases, 'Bcc.Mask@Example.net', {
      aliasId: 'wild', fromEmail: 'bcc.mask@example.net', displayEmail: 'bcc.mask@example.net',
    }],
  ])('matches %s case-insensitively', (_label, candidateAliases, candidate, expected) => {
    expect(matchAuthorizedSender({ account, aliases: candidateAliases, candidates: [candidate] }))
      .toMatchObject(expected);
  });

  it('does not authorize a delivery header without a matching identity', () => {
    expect(matchAuthorizedSender({ account, aliases, candidates: ['attacker@evil.example'] })).toBeNull();
  });

  it.each([
    '*example.net',
    '**@example.net',
    '*@example.net@evil.example',
    '*@',
    '*@example.net/path',
  ])('ignores invalid wildcard shape %s', email => {
    const invalid = [{ ...aliases[2], email }];
    expect(matchAuthorizedSender({ account, aliases: invalid, candidates: ['mask@example.net'] })).toBeNull();
  });

  it('requires a provider identity ID for wildcard authorization', () => {
    const unverified = [{ ...aliases[2], fastmail_identity_id: null }];
    expect(matchAuthorizedSender({ account, aliases: unverified, candidates: ['mask@example.net'] })).toBeNull();
  });

  it('returns null when no candidate matches', () => {
    expect(matchAuthorizedSender({ account, aliases, candidates: [] })).toBeNull();
  });
});

describe('resolveMessageSender', () => {
  const message = {
    id: 'm1', account_id: 'a1', from_email: 'draft-alias@example.com',
    delivery_addresses: ['first@example.net'],
    to_addresses: [],
    cc_addresses: [],
  };

  beforeEach(() => {
    query.mockReset();
    syncFastmailAliases.mockReset();
    syncFastmailAliases.mockResolvedValue([]);
  });

  function mockOwnedMessage(rowsBeforeSync, rowsAfterSync = rowsBeforeSync, messageOverrides = {}) {
    let aliasLoads = 0;
    query.mockImplementation(async sql => {
      if (sql.includes('FROM messages m')) return { rows: [{ ...message, ...account, ...messageOverrides }] };
      if (sql.includes('FROM account_aliases')) {
        aliasLoads += 1;
        return { rows: aliasLoads === 1 ? rowsBeforeSync : rowsAfterSync };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    return () => aliasLoads;
  }

  it('builds reply candidates from delivery addresses, To, then Cc without using From', async () => {
    mockOwnedMessage([
      { ...aliases[2], email: '*@example.net' },
      aliases[0],
    ], undefined, {
      to_addresses: [{ email: 'alias@example.com' }],
      cc_addresses: [{ email: 'owner@example.com' }],
    });

    const result = await resolveMessageSender({ messageId: 'm1', userId: 'u1', purpose: 'reply' });

    expect(result.sender).toMatchObject({ aliasId: 'wild', fromEmail: 'first@example.net' });
    expect(syncFastmailAliases).not.toHaveBeenCalled();
  });

  it('returns the inherited account signature through the complete resolver path', async () => {
    query.mockImplementation(async sql => {
      if (sql.includes('FROM messages m')) {
        const selectedAccountFields = sql.includes('a.signature')
          ? { signature: '<p>Account signature</p>' }
          : {};
        return {
          rows: [{
            ...message,
            ...account,
            delivery_addresses: ['alias@example.com'],
            ...selectedAccountFields,
          }],
        };
      }
      if (sql.includes('FROM account_aliases')) {
        return { rows: [{ ...aliases[0], signature: null }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const result = await resolveMessageSender({ messageId: 'm1', userId: 'u1', purpose: 'reply' });

    expect(result.sender).toMatchObject({
      aliasId: 'provider',
      signature: '<p>Account signature</p>',
    });
  });

  it('refreshes exactly once, reloads aliases, and resolves a newly created mask', async () => {
    const aliasLoadCount = mockOwnedMessage([], [
      { ...aliases[2], email: '*@example.net' },
    ]);

    const result = await resolveMessageSender({ messageId: 'm1', userId: 'u1', purpose: 'reply' });

    expect(syncFastmailAliases).toHaveBeenCalledTimes(1);
    expect(syncFastmailAliases).toHaveBeenCalledWith('a1');
    expect(aliasLoadCount()).toBe(2);
    expect(result).toMatchObject({
      sender: { aliasId: 'wild', fromEmail: 'first@example.net' },
      requiresSelection: false,
    });
  });

  it('returns an unresolved result after the one reply-time retry', async () => {
    const aliasLoadCount = mockOwnedMessage([], []);

    const result = await resolveMessageSender({ messageId: 'm1', userId: 'u1', purpose: 'reply' });

    expect(syncFastmailAliases).toHaveBeenCalledTimes(1);
    expect(aliasLoadCount()).toBe(2);
    expect(result).toEqual({ sender: null, requiresSelection: true });
  });

  it('returns an unresolved result when the reply-time refresh fails', async () => {
    const aliasLoadCount = mockOwnedMessage([]);
    syncFastmailAliases.mockRejectedValue(new Error('Fastmail unavailable'));

    await expect(resolveMessageSender({ messageId: 'm1', userId: 'u1', purpose: 'reply' }))
      .resolves.toEqual({ sender: null, requiresSelection: true });
    expect(syncFastmailAliases).toHaveBeenCalledTimes(1);
    expect(aliasLoadCount()).toBe(1);
  });

  it('does not refresh when the account has no Fastmail token', async () => {
    mockOwnedMessage([]);
    query.mockImplementation(async sql => {
      if (sql.includes('FROM messages m')) return { rows: [{ ...message, ...account, fastmail_api_token: null }] };
      if (sql.includes('FROM account_aliases')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    expect(await resolveMessageSender({ messageId: 'm1', userId: 'u1', purpose: 'reply' }))
      .toEqual({ sender: null, requiresSelection: true });
    expect(syncFastmailAliases).not.toHaveBeenCalled();
  });

  it('matches draft mode only against message.from_email and never refreshes', async () => {
    mockOwnedMessage([
      { ...aliases[1], email: 'draft-alias@example.com' },
      aliases[0],
    ]);

    const result = await resolveMessageSender({ messageId: 'm1', userId: 'u1', purpose: 'draft' });

    expect(result.sender).toMatchObject({ aliasId: 'manual', displayEmail: 'draft-alias@example.com' });
    expect(syncFastmailAliases).not.toHaveBeenCalled();
  });

  it('returns unresolved draft state rather than considering reply recipients', async () => {
    mockOwnedMessage([aliases[0]]);

    expect(await resolveMessageSender({ messageId: 'm1', userId: 'u1', purpose: 'draft' }))
      .toEqual({ sender: null, requiresSelection: true });
    expect(syncFastmailAliases).not.toHaveBeenCalled();
  });

  it('throws a 404 error for a missing or unowned message', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(resolveMessageSender({ messageId: 'm1', userId: 'other', purpose: 'reply' }))
      .rejects.toMatchObject({ status: 404 });
  });
});

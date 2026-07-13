import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authorizeSender } from './senderAuthorization.js';

const account = {
  id: 'a1', user_id: 'u1', name: 'Fastmail', sender_name: 'Account Owner',
  email_address: 'owner@example.com', signature: '<p>Account signature</p>',
};

const manualAlias = {
  id: 'manual', account_id: 'a1', name: 'Manual Alias', email: 'manual@example.com',
  reply_to: 'reply@example.com', signature: '<p>Alias signature</p>',
  provenance: 'manual', fastmail_identity_id: null,
};

const providerAlias = {
  ...manualAlias, id: 'provider', name: 'Provider Alias', email: 'alias@example.com',
  provenance: 'fastmail', fastmail_identity_id: 'identity-1',
  fastmail_reply_to: [{ name: '', email: 'reply@example.com' }], fastmail_bcc: [],
};

const wildcardAlias = {
  ...providerAlias, id: 'wildcard', name: 'Wildcard Identity', email: '*@example.com',
  fastmail_identity_id: 'identity-wildcard',
};

describe('authorizeSender', () => {
  let queryFn;

  beforeEach(() => {
    queryFn = vi.fn();
  });

  it('rejects an explicitly supplied stale alias instead of using the account address', async () => {
    queryFn.mockResolvedValueOnce({ rows: [account] }).mockResolvedValueOnce({ rows: [] });
    await expect(authorizeSender({
      userId: 'u1',
      sender: { accountId: account.id, aliasId: 'missing', fromEmail: null },
    }, queryFn)).rejects.toMatchObject({ status: 422, code: 'SENDER_UNAVAILABLE' });
  });

  it('allows a derived address only through its verified wildcard identity', async () => {
    queryFn.mockResolvedValueOnce({ rows: [account] }).mockResolvedValueOnce({ rows: [wildcardAlias] });
    await expect(authorizeSender({
      userId: 'u1',
      sender: { accountId: account.id, aliasId: wildcardAlias.id, fromEmail: 'mask@example.com' },
    }, queryFn)).resolves.toMatchObject({
      account,
      fromName: 'Wildcard Identity',
      fromEmail: 'mask@example.com',
      fromReplyTo: ['reply@example.com'],
      fromSignature: '<p>Alias signature</p>',
    });
  });

  it.each([
    ['missing sender', null],
    ['missing sender object', undefined],
    ['missing account ID', { accountId: '', aliasId: null, fromEmail: null }],
  ])('rejects %s', async (_label, sender) => {
    await expect(authorizeSender({ userId: 'u1', sender }, queryFn))
      .rejects.toMatchObject({ status: 422, code: 'SENDER_UNAVAILABLE' });
    expect(queryFn).not.toHaveBeenCalled();
  });

  it('rejects an unowned account', async () => {
    queryFn.mockResolvedValueOnce({ rows: [] });
    await expect(authorizeSender({
      userId: 'other', sender: { accountId: 'a1', aliasId: null, fromEmail: null },
    }, queryFn)).rejects.toMatchObject({ status: 422, code: 'SENDER_UNAVAILABLE' });
  });

  it('allows an explicit primary selection', async () => {
    queryFn.mockResolvedValueOnce({ rows: [account] });
    await expect(authorizeSender({
      userId: 'u1', sender: { accountId: 'a1', aliasId: null, fromEmail: null },
    }, queryFn)).resolves.toMatchObject({
      account, fromName: 'Account Owner', fromEmail: 'owner@example.com',
      fromReplyTo: null, fromSignature: '<p>Account signature</p>',
    });
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('rejects a derived address without an alias', async () => {
    queryFn.mockResolvedValueOnce({ rows: [account] });
    await expect(authorizeSender({
      userId: 'u1', sender: { accountId: 'a1', aliasId: null, fromEmail: 'mask@example.com' },
    }, queryFn)).rejects.toMatchObject({ status: 422, code: 'SENDER_UNAVAILABLE' });
  });

  it.each([
    ['an omitted alias selection', { accountId: 'a1', fromEmail: null }],
    ['an empty alias selection', { accountId: 'a1', aliasId: '', fromEmail: null }],
    ['an omitted primary fromEmail marker', { accountId: 'a1', aliasId: null }],
  ])('rejects %s instead of treating it as primary', async (_label, sender) => {
    queryFn.mockResolvedValueOnce({ rows: [account] });
    await expect(authorizeSender({ userId: 'u1', sender }, queryFn))
      .rejects.toMatchObject({ status: 422, code: 'SENDER_UNAVAILABLE' });
  });

  it.each([
    ['manual alias', manualAlias],
    ['verified provider alias', providerAlias],
  ])('allows an exact %s and returns trusted metadata', async (_label, alias) => {
    queryFn.mockResolvedValueOnce({ rows: [account] }).mockResolvedValueOnce({ rows: [alias] });
    await expect(authorizeSender({
      userId: 'u1', sender: { accountId: 'a1', aliasId: alias.id, fromEmail: null },
    }, queryFn)).resolves.toMatchObject({
      account, fromName: alias.name, fromEmail: alias.email,
      fromReplyTo: alias.provenance === 'fastmail' ? ['reply@example.com'] : alias.reply_to,
      fromSignature: alias.signature,
    });
  });

  it('preserves a blank Fastmail identity name instead of borrowing the account name', async () => {
    const blankNameAlias = { ...providerAlias, name: '' };
    queryFn.mockResolvedValueOnce({ rows: [account] }).mockResolvedValueOnce({ rows: [blankNameAlias] });

    await expect(authorizeSender({
      userId: 'u1', sender: { accountId: 'a1', aliasId: blankNameAlias.id, fromEmail: null },
    }, queryFn)).resolves.toMatchObject({
      fromName: '',
      fromEmail: blankNameAlias.email,
    });
  });

  it('omits Reply-To for a Fastmail identity with no reply-to addresses', async () => {
    const noReplyToAlias = { ...providerAlias, fastmail_reply_to: [] };
    queryFn.mockResolvedValueOnce({ rows: [account] }).mockResolvedValueOnce({ rows: [noReplyToAlias] });

    await expect(authorizeSender({
      userId: 'u1', sender: { accountId: 'a1', aliasId: noReplyToAlias.id, fromEmail: null },
    }, queryFn)).resolves.toMatchObject({ fromEmail: noReplyToAlias.email, fromReplyTo: null });
  });

  it('returns complete Fastmail identity Reply-To and Bcc routing', async () => {
    const routedAlias = {
      ...providerAlias,
      fastmail_reply_to: [
        { name: 'Support', email: 'support@example.com' },
        { name: '', email: 'archive@example.com' },
      ],
      fastmail_bcc: [{ name: 'Compliance', email: 'compliance@example.com' }],
    };
    queryFn.mockResolvedValueOnce({ rows: [account] }).mockResolvedValueOnce({ rows: [routedAlias] });

    await expect(authorizeSender({
      userId: 'u1', sender: { accountId: 'a1', aliasId: routedAlias.id, fromEmail: null },
    }, queryFn)).resolves.toMatchObject({
      fromReplyTo: [
        { name: 'Support', address: 'support@example.com' },
        'archive@example.com',
      ],
      fromBcc: [{ name: 'Compliance', address: 'compliance@example.com' }],
    });
  });

  it('rejects a verified provider row with a malformed email address', async () => {
    const malformedAlias = { ...providerAlias, email: 'not-an-address' };
    queryFn.mockResolvedValueOnce({ rows: [account] }).mockResolvedValueOnce({ rows: [malformedAlias] });

    await expect(authorizeSender({
      userId: 'u1', sender: { accountId: 'a1', aliasId: malformedAlias.id, fromEmail: null },
    }, queryFn)).rejects.toMatchObject({ status: 422, code: 'SENDER_UNAVAILABLE' });
  });

  it('inherits the account signature when an exact alias has no signature', async () => {
    const alias = { ...manualAlias, signature: null };
    queryFn.mockResolvedValueOnce({ rows: [account] }).mockResolvedValueOnce({ rows: [alias] });
    await expect(authorizeSender({
      userId: 'u1', sender: { accountId: 'a1', aliasId: alias.id, fromEmail: null },
    }, queryFn)).resolves.toMatchObject({ fromSignature: account.signature });
  });

  it('rejects an exact alias when the fromEmail marker is omitted', async () => {
    queryFn.mockResolvedValueOnce({ rows: [account] }).mockResolvedValueOnce({ rows: [manualAlias] });
    await expect(authorizeSender({
      userId: 'u1', sender: { accountId: 'a1', aliasId: manualAlias.id },
    }, queryFn)).rejects.toMatchObject({ status: 422, code: 'SENDER_UNAVAILABLE' });
  });

  it.each([
    ['derived address with an exact alias', providerAlias, 'mask@example.com'],
    ['wrong wildcard domain', wildcardAlias, 'mask@other.example'],
    ['invalid wildcard syntax', { ...wildcardAlias, email: '*example.com' }, 'mask@example.com'],
    ['Fastmail wildcard without identity ID', { ...wildcardAlias, fastmail_identity_id: null }, 'mask@example.com'],
    ['Fastmail exact alias without identity ID', { ...providerAlias, fastmail_identity_id: null }, null],
    ['provider mask-only exact row', { ...providerAlias, fastmail_identity_id: null, fastmail_masked_email_id: 'mask-1' }, null],
    ['alias from another account', { ...manualAlias, account_id: 'a2' }, null],
  ])('rejects %s', async (_label, alias, fromEmail) => {
    queryFn.mockResolvedValueOnce({ rows: [account] }).mockResolvedValueOnce({ rows: [alias] });
    await expect(authorizeSender({
      userId: 'u1', sender: { accountId: 'a1', aliasId: alias.id, fromEmail },
    }, queryFn)).rejects.toMatchObject({ status: 422, code: 'SENDER_UNAVAILABLE' });
  });

  it.each([
    'mask example.com',
    'mask@example.com\r\nBcc: victim@example.com',
    'mask@example.com\0',
    '@example.com',
    'mask@',
    'mask@@example.com',
  ])('rejects invalid derived address %j', async fromEmail => {
    queryFn.mockResolvedValueOnce({ rows: [account] }).mockResolvedValueOnce({ rows: [wildcardAlias] });
    await expect(authorizeSender({
      userId: 'u1', sender: { accountId: 'a1', aliasId: wildcardAlias.id, fromEmail },
    }, queryFn)).rejects.toMatchObject({ status: 422, code: 'SENDER_UNAVAILABLE' });
  });
});

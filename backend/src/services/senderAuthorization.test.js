import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

const { query } = await import('./db.js');
const { authorizeSendableAddress } = await import('./senderAuthorization.js');

const ACCOUNT_ID = 'acct-1';

beforeEach(() => {
  query.mockReset();
});

describe('authorizeSendableAddress', () => {
  it('authorizes an exact address match', async () => {
    query.mockResolvedValueOnce({ rows: [{ address: 'sales@example.com', name: 'Sales', reply_to: [] }] });

    const result = await authorizeSendableAddress({ accountId: ACCOUNT_ID, fromEmail: 'Sales@Example.com' });

    expect(result).toEqual({ fromName: 'Sales', fromEmail: 'sales@example.com', replyTo: null });
  });

  it('authorizes a wildcard-covered address', async () => {
    query.mockResolvedValueOnce({ rows: [{ address: '*@example.com', name: 'Catch-all', reply_to: [] }] });

    const result = await authorizeSendableAddress({ accountId: ACCOUNT_ID, fromEmail: 'anything@example.com' });

    expect(result).toEqual({ fromName: 'Catch-all', fromEmail: 'anything@example.com', replyTo: null });
  });

  it('prefers an exact match over a wildcard row that also covers it', async () => {
    query.mockResolvedValueOnce({
      rows: [
        { address: '*@example.com', name: 'Catch-all', reply_to: [] },
        { address: 'sales@example.com', name: 'Sales', reply_to: [] },
      ],
    });

    const result = await authorizeSendableAddress({ accountId: ACCOUNT_ID, fromEmail: 'sales@example.com' });

    expect(result.fromName).toBe('Sales');
  });

  it('rejects a fromEmail not present in the sendable set', async () => {
    query.mockResolvedValueOnce({ rows: [{ address: 'sales@example.com', name: 'Sales', reply_to: [] }] });

    await expect(authorizeSendableAddress({ accountId: ACCOUNT_ID, fromEmail: 'unknown@example.com' }))
      .rejects.toMatchObject({ status: 422, code: 'SENDER_UNAVAILABLE' });
  });

  it('rejects when the account has no synced identities at all', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(authorizeSendableAddress({ accountId: ACCOUNT_ID, fromEmail: 'sales@example.com' }))
      .rejects.toMatchObject({ code: 'SENDER_UNAVAILABLE' });
  });

  it('rejects a malformed fromEmail before querying', async () => {
    await expect(authorizeSendableAddress({ accountId: ACCOUNT_ID, fromEmail: 'not-an-email' }))
      .rejects.toMatchObject({ code: 'SENDER_UNAVAILABLE' });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a matched row whose stored name contains header control characters', async () => {
    query.mockResolvedValueOnce({ rows: [{ address: 'sales@example.com', name: 'Evil\r\nBcc: x@evil.example', reply_to: [] }] });

    await expect(authorizeSendableAddress({ accountId: ACCOUNT_ID, fromEmail: 'sales@example.com' }))
      .rejects.toMatchObject({ code: 'SENDER_UNAVAILABLE' });
  });

  it('maps reply_to to nodemailer shape, dropping an entry with an unusable address', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        address: 'sales@example.com',
        name: 'Sales',
        reply_to: [{ name: 'Help Desk', email: 'help@example.com' }, { email: 'bad-address' }],
      }],
    });

    const result = await authorizeSendableAddress({ accountId: ACCOUNT_ID, fromEmail: 'sales@example.com' });

    expect(result.replyTo).toEqual([{ name: 'Help Desk', address: 'help@example.com' }]);
  });

  it('omits replyTo entirely (null) when the identity has an empty reply_to', async () => {
    query.mockResolvedValueOnce({ rows: [{ address: 'sales@example.com', name: 'Sales', reply_to: [] }] });

    const result = await authorizeSendableAddress({ accountId: ACCOUNT_ID, fromEmail: 'sales@example.com' });

    expect(result.replyTo).toBeNull();
  });
});

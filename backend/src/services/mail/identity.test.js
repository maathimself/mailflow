import { describe, expect, it, vi } from 'vitest';
import { AliasNotFoundError, resolveFromIdentity } from './identity.js';

const account = {
  id: 'account-1',
  name: 'Account Name',
  sender_name: 'Sender Name',
  email_address: 'account@example.com',
  signature: '<p>Account sig</p>',
};

describe('resolveFromIdentity', () => {
  it('returns the already-scoped account identity when no selector is supplied', async () => {
    const query = vi.fn();
    await expect(resolveFromIdentity(account, {}, { query })).resolves.toEqual({
      fromName: 'Sender Name',
      fromEmail: 'account@example.com',
      fromReplyTo: null,
      signature: '<p>Account sig</p>',
      aliasId: null,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('falls back from sender_name to account name', async () => {
    const identity = await resolveFromIdentity({ ...account, sender_name: null }, null, { query: vi.fn() });
    expect(identity.fromName).toBe('Account Name');
  });

  it('resolves an alias id within the scoped account and inherits a null signature', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      id: 'alias-1',
      name: 'Alias Name',
      email: 'alias@example.com',
      reply_to: 'reply@example.com',
      signature: null,
    }] });

    await expect(resolveFromIdentity(account, { aliasId: 'alias-1' }, { query })).resolves.toEqual({
      fromName: 'Alias Name',
      fromEmail: 'alias@example.com',
      fromReplyTo: 'reply@example.com',
      signature: '<p>Account sig</p>',
      aliasId: 'alias-1',
    });
    expect(query).toHaveBeenCalledWith(
      'SELECT * FROM account_aliases WHERE id = $1 AND account_id = $2',
      ['alias-1', 'account-1'],
    );
  });

  it('resolves an alias email case-insensitively and honors an explicit empty signature', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      id: 'alias-2',
      name: 'Email Alias',
      email: 'alias@example.com',
      reply_to: null,
      signature: '',
    }] });

    const identity = await resolveFromIdentity(account, { aliasEmail: 'ALIAS@example.com' }, { query });
    expect(identity).toEqual({
      fromName: 'Email Alias',
      fromEmail: 'alias@example.com',
      fromReplyTo: null,
      signature: '',
      aliasId: 'alias-2',
    });
    expect(query).toHaveBeenCalledWith(
      'SELECT * FROM account_aliases WHERE account_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1',
      ['account-1', 'ALIAS@example.com'],
    );
  });

  it.each([
    [{ aliasId: 'missing' }],
    [{ aliasEmail: 'missing@example.com' }],
  ])('hard-errors rather than silently falling back for selector %j', async (selector) => {
    const error = await resolveFromIdentity(account, selector, {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    }).catch(err => err);

    expect(error).toBeInstanceOf(AliasNotFoundError);
    expect(error).toMatchObject({
      message: 'Alias not found',
      status: 422,
      code: 'alias_not_found',
      expose: true,
    });
  });
});

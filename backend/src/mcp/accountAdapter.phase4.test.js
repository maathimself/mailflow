import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SAFE_FIELDS } from '../services/accountFields.js';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../services/accountService.js', () => ({
  reconcileConnectionState: vi.fn(),
}));
vi.mock('../services/gtdConfig.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    invalidateGtdConfigCache: vi.fn(),
  };
});
vi.mock('../services/gtdTransitions.js', () => ({
  invalidateOwnerAddressesCache: vi.fn(),
}));
vi.mock('../services/inboxRules.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    applyInboxRules: vi.fn(),
    toRuleMessage: vi.fn(actual.toRuleMessage),
  };
});

import { query } from '../services/db.js';
import { reconcileConnectionState } from '../services/accountService.js';
import { invalidateGtdConfigCache } from '../services/gtdConfig.js';
import { invalidateOwnerAddressesCache } from '../services/gtdTransitions.js';
import { applyInboxRules } from '../services/inboxRules.js';
import * as accountAdapter from './accountAdapter.js';

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECOND_ACCOUNT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const accountIds = [ACCOUNT_ID, SECOND_ACCOUNT_ID];

function exported(name) {
  expect(accountAdapter[name], `${name} must be exported`).toBeTypeOf('function');
  return accountAdapter[name];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listAccountsSafe', () => {
  it('passes an exact SAFE_FIELDS SQL column list and attaches aliases in one query', async () => {
    const account = Object.fromEntries(SAFE_FIELDS.map((field) => [field, null]));
    account.id = ACCOUNT_ID;
    account.email_address = 'owner@example.com';
    query
      .mockResolvedValueOnce({ rows: [account] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'alias-1',
          account_id: ACCOUNT_ID,
          name: 'Alias',
          email: 'alias@example.com',
          signature: '<script>x</script><b>safe</b>',
        }],
      });

    const result = await exported('listAccountsSafe')([ACCOUNT_ID]);

    expect(result).toEqual([expect.objectContaining({
      id: ACCOUNT_ID,
      email_address: 'owner@example.com',
      aliases: [expect.objectContaining({
        id: 'alias-1',
        signature: '<b>safe</b>',
      })],
    })]);
    const accountSql = query.mock.calls[0][0];
    const columns = accountSql
      .slice(accountSql.indexOf('SELECT') + 6, accountSql.indexOf('FROM email_accounts'))
      .split(',')
      .map((column) => column.trim())
      .filter(Boolean);
    expect(columns).toEqual(SAFE_FIELDS);
    expect(accountSql).not.toMatch(/\bauth_pass\b|\boauth_access_token\b|\boauth_refresh_token\b/);
    expect(query.mock.calls[1][0]).toMatch(
      /SELECT id, account_id, name, email, reply_to, signature, created_at[\s\S]*account_id = ANY\(\$1\)/,
    );
    expect(query.mock.calls[1][1]).toEqual([[ACCOUNT_ID]]);
  });

  it('does not query for an empty account scope', async () => {
    await expect(exported('listAccountsSafe')([])).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('updateAccountSettings', () => {
  it('rejects reserved and colliding GTD folder mappings before UPDATE', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, gtd_folders: {} }] });
    const reserved = await exported('updateAccountSettings')({
      accountId: ACCOUNT_ID,
      accountIds,
      updates: { gtd_folders: { todo: 'INBOX' } },
    });
    expect(reserved).toEqual({
      error: 'A GTD state cannot map to a reserved system folder',
      reserved: ['todo'],
      status: 400,
    });
    expect(query).toHaveBeenCalledTimes(1);

    query.mockReset();
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, gtd_folders: {} }] });
    const collision = await exported('updateAccountSettings')({
      accountId: ACCOUNT_ID,
      accountIds,
      updates: { gtd_folders: { todo: 'Work', watch: 'Work' } },
    });
    expect(collision.error).toBe('Two GTD states cannot map to the same folder');
    expect(collision.collisions).toEqual([{ folder: 'Work', states: ['todo', 'watch'] }]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns a safe row, reports rejected folders, invalidates GTD, and reconciles once', async () => {
    const updated = Object.fromEntries(SAFE_FIELDS.map((field) => [field, null]));
    updated.id = ACCOUNT_ID;
    updated.protocol = 'imap';
    updated.enabled = true;
    updated.gtd_enabled = true;
    query
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, gtd_folders: {} }] })
      .mockResolvedValueOnce({ rows: [updated] });

    const result = await exported('updateAccountSettings')({
      accountId: ACCOUNT_ID,
      accountIds,
      updates: {
        name: 'Updated',
        signature: '<script>x</script><b>safe</b>',
        gtd_enabled: true,
        gtd_folders: { todo: 'Work', watch: '../bad' },
      },
    });

    expect(result.account).toEqual(expect.objectContaining({
      id: ACCOUNT_ID,
      signature: null,
      gtd_folders_rejected: ['watch'],
    }));
    const [sql, values] = query.mock.calls[1];
    expect(sql).toMatch(/UPDATE email_accounts SET/);
    expect(sql).toMatch(/WHERE id = \$\d+ AND id = ANY\(\$\d+\) RETURNING \*/);
    expect(values).toContain('<b>safe</b>');
    expect(invalidateGtdConfigCache).toHaveBeenCalledTimes(1);
    expect(invalidateGtdConfigCache).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(reconcileConnectionState).toHaveBeenCalledTimes(1);
    expect(reconcileConnectionState).toHaveBeenCalledWith(expect.objectContaining({
      id: ACCOUNT_ID,
      updates: expect.objectContaining({ gtd_enabled: true }),
      before: { gtdFoldersChanged: true },
      updated,
    }));
  });

  it('returns Account not found without updating when the scoped row is absent', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(exported('updateAccountSettings')({
      accountId: ACCOUNT_ID,
      accountIds,
      updates: { name: 'Nope' },
    })).resolves.toEqual({ error: 'Account not found', status: 404 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(reconcileConnectionState).not.toHaveBeenCalled();
  });
});

describe('alias mutations', () => {
  const fields = {
    name: 'Alias',
    email: 'alias@example.com',
    reply_to: 'reply@example.com',
    signature: '<b>Sig</b>',
  };

  it.each([
    ['createAlias', { fields }],
    ['updateAlias', { aliasId: 'alias-1', fields }],
    ['deleteAlias', { aliasId: 'alias-1' }],
  ])('%s rejects ownership misses before mutation', async (name, extra) => {
    query.mockResolvedValueOnce({ rows: [] });

    const result = await exported(name)({
      accountId: ACCOUNT_ID,
      accountIds,
      userId: 'wrong-user',
      ...extra,
    });

    expect(result === null || result === false).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    expect(invalidateOwnerAddressesCache).not.toHaveBeenCalled();
  });

  it.each([
    ['createAlias', {
      extra: { fields },
      responses: [{ rows: [{ id: ACCOUNT_ID }] }, { rows: [{ id: 'alias-1' }] }],
      expected: { id: 'alias-1' },
    }],
    ['updateAlias', {
      extra: { aliasId: 'alias-1', fields },
      responses: [
        { rows: [{ id: 'alias-1', account_id: ACCOUNT_ID }] },
        { rows: [{ id: 'alias-1' }] },
      ],
      expected: { id: 'alias-1' },
    }],
    ['deleteAlias', {
      extra: { aliasId: 'alias-1' },
      responses: [
        { rows: [{ id: 'alias-1', account_id: ACCOUNT_ID }] },
        { rows: [], rowCount: 1 },
      ],
      expected: true,
    }],
  ])('%s invalidates owner addresses exactly once after success', async (name, spec) => {
    for (const response of spec.responses) query.mockResolvedValueOnce(response);

    await expect(exported(name)({
      accountId: ACCOUNT_ID,
      accountIds,
      userId: 'user-1',
      ...spec.extra,
    })).resolves.toEqual(spec.expected);
    expect(invalidateOwnerAddressesCache).toHaveBeenCalledTimes(1);
    expect(invalidateOwnerAddressesCache).toHaveBeenCalledWith(ACCOUNT_ID);
  });
});

describe('rule persistence', () => {
  it('lists global and account-specific rules for an optional account filter', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'rule-1' }] });

    await expect(exported('listRules')({
      userId: 'user-1',
      accountId: ACCOUNT_ID,
    })).resolves.toEqual([{ id: 'rule-1' }]);
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/user_id = \$1 AND \(account_id IS NULL OR account_id = \$2\).*ORDER BY priority, created_at/s),
      ['user-1', ACCOUNT_ID],
    );
  });

  it('creates a user-owned rule with REST defaults and priority', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ cnt: '4' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'rule-1' }] });

    await expect(exported('createRule')({
      userId: 'user-1',
      accountId: ACCOUNT_ID,
      name: 'Rule',
      conditionLogic: 'OR',
      conditions: [{ field: 'from', value: 'example.com' }],
      actions: [{ type: 'archive' }],
      enabled: true,
      stopProcessing: false,
    })).resolves.toEqual({ id: 'rule-1' });
    expect(query.mock.calls[1][0]).toMatch(/INSERT INTO inbox_rules/);
    expect(query.mock.calls[1][1]).toEqual([
      'user-1',
      ACCOUNT_ID,
      'Rule',
      true,
      false,
      4,
      'OR',
      JSON.stringify([{ field: 'from', value: 'example.com' }]),
      JSON.stringify([{ type: 'archive' }]),
    ]);
  });

  it('updates and deletes only rules owned by the scoped user', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(exported('updateRule')({
      userId: 'wrong-user',
      ruleId: 'rule-1',
      accountId: null,
      name: 'Rule',
      conditionLogic: 'AND',
      conditions: [],
      actions: [],
    })).resolves.toBeNull();
    expect(query.mock.calls[0][0]).toMatch(/WHERE id = \$8 AND user_id = \$9/);

    query.mockReset();
    query.mockResolvedValueOnce({ rows: [] });
    await expect(exported('deleteRule')({
      userId: 'wrong-user',
      ruleId: 'rule-1',
    })).resolves.toBe(false);
    expect(query).toHaveBeenCalledWith(
      'DELETE FROM inbox_rules WHERE id = $1 AND user_id = $2 RETURNING id',
      ['rule-1', 'wrong-user'],
    );
  });
});

describe('runRules', () => {
  it('skips accounts with no enabled rules and batches inbox messages for the rest', async () => {
    const imapManager = { marker: 'injected' };
    const account = { id: SECOND_ACCOUNT_ID, email_address: 'second@example.com' };
    query
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }] })
      .mockResolvedValueOnce({ rows: [{ cnt: '1' }] })
      .mockResolvedValueOnce({ rows: [account] })
      .mockResolvedValueOnce({
        rows: [
          { id: 'm1', uid: 1, folder: 'INBOX', subject: 'One' },
          { id: 'm2', uid: 2, folder: 'INBOX', subject: 'Two' },
        ],
      });
    applyInboxRules.mockResolvedValue({ remaining: [{ id: 'm2' }] });

    const result = await exported('runRules')({
      userId: 'user-1',
      accountIds,
      imapManager,
    });

    expect(result).toEqual({ processed: 2, matched: 1 });
    expect(applyInboxRules).toHaveBeenCalledTimes(1);
    expect(applyInboxRules.mock.calls[0][1]).toEqual(account);
    expect(applyInboxRules.mock.calls[0][2]).toBe(imapManager);
    const messageSql = query.mock.calls[3][0];
    expect(messageSql).toMatch(/lower\(folder\) = 'inbox'/);
    expect(messageSql).toMatch(/ORDER BY id[\s\S]*LIMIT \$2/);
    expect(query.mock.calls[3][1]).toEqual([SECOND_ACCOUNT_ID, 500]);
  });
});

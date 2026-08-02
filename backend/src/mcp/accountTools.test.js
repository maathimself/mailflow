import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockSurfaceDrift } from '../testSupport/mockSurface.js';
import { SAFE_FIELDS } from '../services/accountFields.js';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('./accountAdapter.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    getAccountRow: vi.fn(),
    listAccountsSafe: vi.fn(),
    updateAccountSettings: vi.fn(),
    createAlias: vi.fn(),
    updateAlias: vi.fn(),
    deleteAlias: vi.fn(),
    listRules: vi.fn(),
    createRule: vi.fn(),
    updateRule: vi.fn(),
    deleteRule: vi.fn(),
    runRules: vi.fn(),
  };
});
vi.mock('./engineAdapter.js', async (orig) => {
  const actual = await orig();
  return { ...actual, resolveAccountScope: vi.fn() };
});
vi.mock('../services/accountService.js', () => ({
  stageAccount: vi.fn(),
  reconcileConnectionState: vi.fn(),
}));
vi.mock('../services/connectionTest.js', () => ({ testConnection: vi.fn() }));
vi.mock('../services/gtdConfig.js', () => ({
  DEFAULT_GTD_FOLDERS: {
    todo: 'Todo',
    watch: 'Watch',
    delegated: 'Delegated',
    someday: 'Someday',
    reference: 'Reference',
  },
  GTD_STATES: ['todo', 'watch', 'delegated', 'someday', 'reference'],
  sanitizeGtdFoldersDetailed: vi.fn((input) => ({
    folders: input || {},
    rejected: [],
    reserved: [],
  })),
  findGtdFolderCollisions: vi.fn(() => []),
  invalidateGtdConfigCache: vi.fn(),
  getGtdFolderSet: vi.fn(async () => new Set()),
}));
vi.mock('../services/gtdTransitions.js', () => ({
  invalidateOwnerAddressesCache: vi.fn(),
}));
vi.mock('../services/inboxRules.js', () => ({
  applyInboxRules: vi.fn(),
  isDangerousRegex: vi.fn(() => false),
  matchingRules: vi.fn(() => []),
  toRuleMessage: vi.fn((message) => message),
}));
vi.mock('../routes/rules.js', () => ({
  validateConditions: vi.fn(),
  normalizeActions: vi.fn(),
}));

const db = await import('../services/db.js');
const accountAdapter = await import('./accountAdapter.js');
const realAccountAdapter = await vi.importActual('./accountAdapter.js');
const engineAdapter = await import('./engineAdapter.js');
const accountService = await import('../services/accountService.js');
const connectionTest = await import('../services/connectionTest.js');
const rulesRoute = await import('../routes/rules.js');
const accountTools = await import('./accountTools.js').catch(() => ({}));
const registeredTools = await import('./tools.js');

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ACCOUNT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACCOUNT_EMAIL = 'owner@example.com';
const scope = {
  userId: 'user-1',
  accountIds: [ACCOUNT_ID, OTHER_ACCOUNT_ID],
  scopes: ['read', 'write', 'settings'],
};
const deps = { imapManager: { marker: 'injected-imap-manager' } };

function handler(name) {
  expect(accountTools[name], `${name} must be exported`).toBeTypeOf('function');
  return accountTools[name];
}

function jsonOf(result) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
  engineAdapter.resolveAccountScope.mockImplementation(async (account, accountIds) => (
    account
      ? { accountIds: [ACCOUNT_ID] }
      : { accountIds }
  ));
  rulesRoute.validateConditions.mockReturnValue(null);
  rulesRoute.normalizeActions.mockImplementation((actions) => actions);
});

describe('account/settings tool definitions and registration', () => {
  it('registers all twelve tools with their required scopes and annotation hints', () => {
    const expected = {
      list_accounts: ['read', true, false, true],
      add_account: ['settings', false, false, false],
      update_account_settings: ['settings', false, false, true],
      test_account_connection: ['settings', true, false, true],
      create_alias: ['settings', false, false, false],
      update_alias: ['settings', false, false, true],
      delete_alias: ['settings', false, true, true],
      list_rules: ['settings', true, false, true],
      create_rule: ['settings', false, false, false],
      update_rule: ['settings', false, false, true],
      delete_rule: ['settings', false, true, true],
      run_rules: [['settings', 'write'], false, true, false],
    };
    const defs = new Map(registeredTools.TOOL_DEFS.map((def) => [def.name, def]));

    for (const [name, [requiredScope, readOnlyHint, destructiveHint, idempotentHint]] of Object.entries(expected)) {
      expect(defs.get(name)?.annotations).toEqual({
        readOnlyHint,
        destructiveHint,
        idempotentHint,
        openWorldHint: false,
      });
      expect(registeredTools.TOOL_SCOPES[name]).toEqual(requiredScope);
      expect(registeredTools.HANDLERS[name]).toBeTypeOf('function');
    }
  });

  it('documents and schemas the no-secrets staged account flow', () => {
    const def = registeredTools.TOOL_DEFS.find(({ name }) => name === 'add_account');
    expect(def?.description).toMatch(/does not accept passwords or OAuth tokens/i);
    expect(def?.description).toMatch(/stage_id/i);
    expect(def?.inputSchema.required).toEqual(['name', 'email_address']);
    expect(def?.inputSchema.properties).not.toHaveProperty('auth_pass');
    expect(def?.inputSchema.properties).not.toHaveProperty('oauth_access_token');
    expect(def?.inputSchema.properties).not.toHaveProperty('oauth_refresh_token');
  });
});

describe('list_accounts', () => {
  it('returns safe accounts with aliases through the adapter seam', async () => {
    const accounts = [{
      id: ACCOUNT_ID,
      email_address: ACCOUNT_EMAIL,
      aliases: [{ id: 'alias-1', email: 'alias@example.com' }],
    }];
    accountAdapter.listAccountsSafe.mockResolvedValue(accounts);

    const result = await handler('handleListAccounts')({}, scope, deps);

    expect(jsonOf(result)).toEqual({ accounts });
    expect(accountAdapter.listAccountsSafe).toHaveBeenCalledWith(scope.accountIds);
  });

  it('passes exactly SAFE_FIELDS to the account query and never selects credentials', async () => {
    const account = Object.fromEntries(SAFE_FIELDS.map((field) => [field, null]));
    account.id = ACCOUNT_ID;
    db.query
      .mockResolvedValueOnce({ rows: [account] })
      .mockResolvedValueOnce({ rows: [] });

    await realAccountAdapter.listAccountsSafe([ACCOUNT_ID]);

    const accountSql = db.query.mock.calls[0][0];
    const columns = accountSql
      .slice(accountSql.indexOf('SELECT') + 6, accountSql.indexOf('FROM email_accounts'))
      .split(',')
      .map((column) => column.trim())
      .filter(Boolean);
    expect(columns).toEqual(SAFE_FIELDS);
    expect(accountSql).not.toMatch(/\bauth_pass\b|\boauth_access_token\b|\boauth_refresh_token\b/);
    expect(db.query.mock.calls[1][0]).toMatch(/account_aliases WHERE account_id = ANY\(\$1\)/);
  });
});

describe('add_account', () => {
  it.each(['auth_pass', 'oauth_access_token', 'oauth_refresh_token'])(
    'rejects %s even when its value is empty before staging',
    async (secretField) => {
      const result = await handler('handleAddAccount')({
        name: 'Mail',
        email_address: ACCOUNT_EMAIL,
        [secretField]: '',
      }, scope, deps);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        'Passwords and OAuth tokens cannot be sent over MCP; finish authentication in the Mailflow settings UI',
      );
      expect(accountService.stageAccount).not.toHaveBeenCalled();
    },
  );

  it('returns the stage id and the exact human-authentication next step', async () => {
    accountService.stageAccount.mockResolvedValue({ id: 'stage-1' });

    const result = await handler('handleAddAccount')({
      name: 'Mail',
      email_address: ACCOUNT_EMAIL,
      imap_host: 'imap.example.com',
    }, scope, deps);

    expect(jsonOf(result)).toEqual({
      stage_id: 'stage-1',
      next_step: 'Open Mailflow Settings > Accounts to finish setup, or POST /api/mcp-account-stages/:id/execute (session-authed) with credentials',
    });
    expect(accountService.stageAccount).toHaveBeenCalledWith({
      userId: scope.userId,
      payload: {
        name: 'Mail',
        email_address: ACCOUNT_EMAIL,
        imap_host: 'imap.example.com',
      },
    });
  });

  it('surfaces host/port validation errors from stageAccount', async () => {
    accountService.stageAccount.mockResolvedValue({
      error: 'IMAP: Port 25 is not allowed. Allowed: 143, 993',
      status: 400,
    });

    const result = await handler('handleAddAccount')({
      name: 'Mail',
      email_address: ACCOUNT_EMAIL,
      imap_port: 25,
    }, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('IMAP: Port 25 is not allowed. Allowed: 143, 993');
  });
});

describe('update_account_settings', () => {
  it.each([
    'auth_user',
    'auth_pass',
    'imap_host',
    'imap_port',
    'imap_tls',
    'imap_skip_tls_verify',
    'smtp_host',
    'smtp_port',
    'smtp_tls',
  ])('hard-errors on excluded field %s instead of silently dropping it', async (field) => {
    const result = await handler('handleUpdateAccountSettings')({
      account: ACCOUNT_EMAIL,
      [field]: field.endsWith('port') ? 993 : 'value',
    }, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      `${field} cannot be changed over MCP; use the Mailflow settings UI`,
    );
    expect(engineAdapter.resolveAccountScope).not.toHaveBeenCalled();
    expect(accountAdapter.updateAccountSettings).not.toHaveBeenCalled();
  });

  it('resolves the account and returns the updated safe row', async () => {
    const account = { id: ACCOUNT_ID, email_address: ACCOUNT_EMAIL, enabled: false };
    accountAdapter.updateAccountSettings.mockResolvedValue({ account });

    const result = await handler('handleUpdateAccountSettings')({
      account: ACCOUNT_EMAIL,
      enabled: false,
      signature: '<b>Bye</b>',
    }, scope, deps);

    expect(jsonOf(result)).toEqual(account);
    expect(accountAdapter.updateAccountSettings).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      accountIds: scope.accountIds,
      updates: { enabled: false, signature: '<b>Bye</b>' },
    });
  });
});

describe('test_account_connection', () => {
  it('loads the scoped full account row and delegates both probes', async () => {
    const fullRow = {
      id: ACCOUNT_ID,
      email_address: ACCOUNT_EMAIL,
      auth_pass: 'encrypted-secret',
    };
    accountAdapter.getAccountRow.mockResolvedValue(fullRow);
    connectionTest.testConnection.mockResolvedValue({
      imap: { ok: true },
      smtp: { ok: false, error: 'SMTP authentication failed' },
    });

    const result = await handler('handleTestAccountConnection')({
      account: ACCOUNT_EMAIL,
    }, scope, deps);

    expect(jsonOf(result)).toEqual({
      account: ACCOUNT_EMAIL,
      imap: { ok: true },
      smtp: { ok: false, error: 'SMTP authentication failed' },
    });
    expect(accountAdapter.getAccountRow).toHaveBeenCalledWith(ACCOUNT_ID, scope.accountIds);
    expect(connectionTest.testConnection).toHaveBeenCalledWith(fullRow);
  });

  it('returns the account-scope error before touching the full-row adapter', async () => {
    engineAdapter.resolveAccountScope.mockResolvedValue({
      error: 'account not found: foreign@example.com',
    });

    const result = await handler('handleTestAccountConnection')({
      account: 'foreign@example.com',
    }, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('account not found: foreign@example.com');
    expect(accountAdapter.getAccountRow).not.toHaveBeenCalled();
    expect(connectionTest.testConnection).not.toHaveBeenCalled();
  });
});

describe('alias CRUD', () => {
  it.each([
    ['handleCreateAlias', 'createAlias', { account: 'foreign@example.com', name: 'Alias', email: 'alias@example.com' }],
    ['handleUpdateAlias', 'updateAlias', { account: 'foreign@example.com', alias_id: 'alias-1', name: 'Alias', email: 'alias@example.com' }],
    ['handleDeleteAlias', 'deleteAlias', { account: 'foreign@example.com', alias_id: 'alias-1' }],
  ])('%s rejects an out-of-scope account before the mutation adapter', async (handlerName, adapterName, args) => {
    engineAdapter.resolveAccountScope.mockResolvedValue({
      error: 'account not found: foreign@example.com',
    });

    const result = await handler(handlerName)(args, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('account not found: foreign@example.com');
    expect(accountAdapter[adapterName]).not.toHaveBeenCalled();
  });

});

describe('rules tools', () => {
  it('list_rules resolves an optional account and returns user-owned rules', async () => {
    const rules = [{ id: 'rule-1', account_id: ACCOUNT_ID }];
    accountAdapter.listRules.mockResolvedValue(rules);

    const result = await handler('handleListRules')({ account: ACCOUNT_EMAIL }, scope, deps);

    expect(jsonOf(result)).toEqual({ rules });
    expect(accountAdapter.listRules).toHaveBeenCalledWith({
      userId: scope.userId,
      accountId: ACCOUNT_ID,
    });
  });

  it.each([
    ['handleCreateRule', 'createRule'],
    ['handleUpdateRule', 'updateRule'],
  ])('%s calls the imported condition validator and action normalizer', async (handlerName, adapterName) => {
    const conditions = [{ field: 'from', operator: 'contains', value: 'example.com' }];
    const actions = [{ type: 'archive' }, { type: 'move', value: 'Archive ' }];
    const normalized = [{ type: 'archive' }];
    rulesRoute.normalizeActions.mockReturnValue(normalized);
    accountAdapter[adapterName].mockResolvedValue({ id: 'rule-1' });
    const args = {
      name: 'Archive example mail',
      account_id: ACCOUNT_EMAIL,
      conditions,
      actions,
      condition_logic: 'OR',
      enabled: true,
      stop_processing: true,
    };
    if (handlerName === 'handleUpdateRule') args.rule_id = 'rule-1';

    const result = await handler(handlerName)(args, scope, deps);

    expect(result.isError).toBeUndefined();
    expect(rulesRoute.validateConditions).toHaveBeenCalledWith(conditions);
    expect(rulesRoute.normalizeActions).toHaveBeenCalledWith(actions);
    expect(accountAdapter[adapterName]).toHaveBeenCalledWith(expect.objectContaining({
      userId: scope.userId,
      accountId: ACCOUNT_ID,
      conditions,
      actions: normalized,
      conditionLogic: 'OR',
      enabled: true,
      stopProcessing: true,
    }));
  });

  it('surfaces validation errors before normalizing or writing', async () => {
    rulesRoute.validateConditions.mockReturnValue('Condition value cannot be empty');

    const result = await handler('handleCreateRule')({
      name: 'Bad',
      conditions: [{ field: 'from', value: '' }],
      actions: [],
    }, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Condition value cannot be empty');
    expect(rulesRoute.normalizeActions).not.toHaveBeenCalled();
    expect(accountAdapter.createRule).not.toHaveBeenCalled();
  });

  it('delete_rule returns an error for a missing user-owned rule', async () => {
    accountAdapter.deleteRule.mockResolvedValue(false);

    const result = await handler('handleDeleteRule')({ rule_id: 'missing' }, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Rule not found');
  });
});

describe('run_rules', () => {
  it('uses every scoped account when account is omitted and threads deps.imapManager', async () => {
    accountAdapter.runRules.mockResolvedValue({ processed: 7, matched: 3 });

    const result = await handler('handleRunRules')({}, scope, deps);

    expect(jsonOf(result)).toEqual({ processed: 7, matched: 3 });
    expect(accountAdapter.runRules).toHaveBeenCalledWith({
      userId: scope.userId,
      accountIds: scope.accountIds,
      imapManager: deps.imapManager,
    });
  });

  it('returns an account scope error without invoking the run loop', async () => {
    engineAdapter.resolveAccountScope.mockResolvedValue({
      error: 'account not found: foreign@example.com',
    });

    const result = await handler('handleRunRules')({
      account: 'foreign@example.com',
    }, scope, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('account not found: foreign@example.com');
    expect(accountAdapter.runRules).not.toHaveBeenCalled();
  });

});

describe('mock-drift guard: mocked seams exist on their real modules', () => {
  it.each([
    ['accountAdapter', () => accountAdapter, './accountAdapter.js'],
    ['engineAdapter', () => engineAdapter, './engineAdapter.js'],
  ])('%s mock surface matches the real module', async (_name, getMock, path) => {
    const real = await vi.importActual(path);
    expect(mockSurfaceDrift(getMock(), real)).toEqual([]);
  });
});

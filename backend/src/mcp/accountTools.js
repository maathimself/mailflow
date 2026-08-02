import {
  createAlias,
  createRule,
  deleteAlias,
  deleteRule,
  getAccountRow,
  listAccountsSafe,
  listRules,
  runRules,
  updateAccountSettings,
  updateAlias,
  updateRule,
} from './accountAdapter.js';
import { resolveAccountScope } from './engineAdapter.js';
import { errorResult, jsonResult } from './result.js';
import {
  hasHeaderInjectionChars,
} from '../services/emailSanitizer.js';
import {
  normalizeActions,
  validateConditions,
} from '../routes/rules.js';

function annotations({
  readOnlyHint = false,
  destructiveHint = false,
  idempotentHint = false,
} = {}) {
  return Object.freeze({
    readOnlyHint,
    destructiveHint,
    idempotentHint,
    openWorldHint: false,
  });
}

const READ_ONLY_ANNOTATIONS = annotations({
  readOnlyHint: true,
  idempotentHint: true,
});
const CREATE_ANNOTATIONS = annotations();
const IDEMPOTENT_WRITE_ANNOTATIONS = annotations({ idempotentHint: true });
const DESTRUCTIVE_ANNOTATIONS = annotations({ destructiveHint: true });
const DESTRUCTIVE_IDEMPOTENT_ANNOTATIONS = annotations({
  destructiveHint: true,
  idempotentHint: true,
});

export const listAccountsDef = {
  name: 'list_accounts',
  description: 'List the connected email accounts and their aliases. Never returns credentials.',
  annotations: READ_ONLY_ANNOTATIONS,
  inputSchema: { type: 'object', properties: {} },
};

export const addAccountDef = {
  name: 'add_account',
  description:
    'Stage a new email account for setup. Does NOT accept passwords or OAuth tokens — the user must complete authentication in the Mailflow settings UI. Returns a stage_id.',
  annotations: CREATE_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    required: ['name', 'email_address'],
    properties: {
      name: { type: 'string' },
      email_address: { type: 'string' },
      sender_name: { type: 'string' },
      color: { type: 'string' },
      protocol: { type: 'string', enum: ['imap'] },
      imap_host: { type: 'string' },
      imap_port: { type: 'integer' },
      smtp_host: { type: 'string' },
      smtp_port: { type: 'integer' },
      smtp_tls: { type: 'string', enum: ['STARTTLS', 'SSL', 'none'] },
      auth_user: { type: 'string' },
      signature: { type: 'string' },
    },
  },
};

export const updateAccountSettingsDef = {
  name: 'update_account_settings',
  description:
    'Update non-secret account settings. Credentials, hosts, ports, and TLS settings must be changed in the Mailflow settings UI.',
  annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    required: ['account'],
    properties: {
      account: { type: 'string', description: 'Account email address (use list_accounts)' },
      name: { type: 'string' },
      sender_name: { type: 'string' },
      color: { type: 'string' },
      sort_order: { type: 'integer' },
      folder_mappings: { type: 'object' },
      signature: { type: 'string' },
      categorization_enabled: { type: 'boolean' },
      gtd_enabled: { type: 'boolean' },
      gtd_folders: { type: 'object' },
      enabled: { type: 'boolean' },
    },
  },
};

export const testAccountConnectionDef = {
  name: 'test_account_connection',
  description:
    'Test IMAP and SMTP connectivity for an existing account using its stored credentials. Does not send mail.',
  annotations: READ_ONLY_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    required: ['account'],
    properties: {
      account: {
        type: 'string',
        description: 'Account email address (use list_accounts)',
      },
    },
  },
};

const aliasFields = {
  name: { type: 'string' },
  email: { type: 'string' },
  reply_to: { type: 'string' },
  signature: { type: 'string' },
};

export const createAliasDef = {
  name: 'create_alias',
  description: 'Create a send-as alias on a scoped account.',
  annotations: CREATE_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    required: ['account', 'name', 'email'],
    properties: {
      account: { type: 'string', description: 'Account email address (use list_accounts)' },
      ...aliasFields,
    },
  },
};

export const updateAliasDef = {
  name: 'update_alias',
  description: 'Update a send-as alias owned by a scoped account.',
  annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    required: ['account', 'alias_id', 'name', 'email'],
    properties: {
      account: { type: 'string', description: 'Account email address (use list_accounts)' },
      alias_id: { type: 'string' },
      ...aliasFields,
    },
  },
};

export const deleteAliasDef = {
  name: 'delete_alias',
  description: 'Delete a send-as alias owned by a scoped account.',
  annotations: DESTRUCTIVE_IDEMPOTENT_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    required: ['account', 'alias_id'],
    properties: {
      account: { type: 'string', description: 'Account email address (use list_accounts)' },
      alias_id: { type: 'string' },
    },
  },
};

export const listRulesDef = {
  name: 'list_rules',
  description: 'List inbox rules owned by the token user, optionally including only global and one account’s rules.',
  annotations: READ_ONLY_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: 'Optional account email address' },
    },
  },
};

const ruleFields = {
  name: { type: 'string' },
  account_id: {
    type: 'string',
    description: 'Optional account email address; the field name matches the REST rule shape',
  },
  condition_logic: { type: 'string', enum: ['AND', 'OR'] },
  conditions: { type: 'array', items: { type: 'object' } },
  actions: { type: 'array', items: { type: 'object' } },
  enabled: { type: 'boolean' },
  stop_processing: { type: 'boolean' },
};

export const createRuleDef = {
  name: 'create_rule',
  description: 'Create an inbox rule for all accounts or one scoped account.',
  annotations: CREATE_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    required: ['name', 'conditions', 'actions'],
    properties: ruleFields,
  },
};

export const updateRuleDef = {
  name: 'update_rule',
  description: 'Replace the settings of a user-owned inbox rule.',
  annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    required: ['rule_id', 'name', 'conditions', 'actions'],
    properties: {
      rule_id: { type: 'string' },
      ...ruleFields,
    },
  },
};

export const deleteRuleDef = {
  name: 'delete_rule',
  description: 'Delete a user-owned inbox rule.',
  annotations: DESTRUCTIVE_IDEMPOTENT_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    required: ['rule_id'],
    properties: {
      rule_id: { type: 'string' },
    },
  },
};

export const runRulesDef = {
  name: 'run_rules',
  description:
    'Run enabled inbox rules against current INBOX messages for all scoped accounts or one account. Rule actions can move, archive, or delete messages.',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: 'Optional account email address' },
    },
  },
};

async function resolvedAccountId(account, scope) {
  const resolved = await resolveAccountScope(account, scope.accountIds);
  if (resolved.error) return resolved;
  const accountId = resolved.accountIds?.[0];
  if (!accountId) return { error: `account not found: ${account}` };
  return { accountId };
}

export async function handleListAccounts(_args, scope) {
  return jsonResult({ accounts: await listAccountsSafe(scope.accountIds) });
}

const SECRET_ACCOUNT_FIELDS = [
  'auth_pass',
  'oauth_access_token',
  'oauth_refresh_token',
];
const SECRET_REJECTION =
  'Passwords and OAuth tokens cannot be sent over MCP; finish authentication in the Mailflow settings UI';

export async function handleAddAccount(args, scope) {
  if (SECRET_ACCOUNT_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(args, field))) {
    return errorResult(SECRET_REJECTION);
  }
  try {
    const { stageAccount } = await import('../services/accountService.js');
    const result = await stageAccount({ userId: scope.userId, payload: args });
    if (result?.error) return errorResult(result.error);
    return jsonResult({
      stage_id: result.id,
      next_step:
        'Open Mailflow Settings > Accounts to finish setup, or POST /api/mcp-account-stages/:id/execute (session-authed) with credentials',
    });
  } catch (error) {
    return errorResult(error.message);
  }
}

const ACCOUNT_UPDATE_FIELDS = new Set([
  'name',
  'sender_name',
  'color',
  'sort_order',
  'folder_mappings',
  'signature',
  'categorization_enabled',
  'gtd_enabled',
  'gtd_folders',
  'enabled',
]);
const UI_ONLY_ACCOUNT_FIELDS = new Set([
  'auth_user',
  'auth_pass',
  'imap_host',
  'imap_port',
  'imap_tls',
  'imap_skip_tls_verify',
  'smtp_host',
  'smtp_port',
  'smtp_tls',
]);

export async function handleUpdateAccountSettings(args, scope) {
  for (const field of Object.keys(args)) {
    if (UI_ONLY_ACCOUNT_FIELDS.has(field)) {
      return errorResult(
        `${field} cannot be changed over MCP; use the Mailflow settings UI`,
      );
    }
    if (field !== 'account' && !ACCOUNT_UPDATE_FIELDS.has(field)) {
      return errorResult(`${field} is not an account setting supported over MCP`);
    }
  }
  if ('name' in args && hasHeaderInjectionChars(args.name)) {
    return errorResult('Name cannot contain control characters');
  }
  if (
    'sender_name' in args
    && args.sender_name
    && hasHeaderInjectionChars(args.sender_name)
  ) {
    return errorResult('Sender name cannot contain control characters');
  }
  const resolved = await resolvedAccountId(args.account, scope);
  if (resolved.error) return errorResult(resolved.error);
  const updates = Object.fromEntries(
    Object.entries(args).filter(([field]) => ACCOUNT_UPDATE_FIELDS.has(field)),
  );
  const result = await updateAccountSettings({
    accountId: resolved.accountId,
    accountIds: scope.accountIds,
    updates,
  });
  if (result.error) return errorResult(result.error);
  return jsonResult(result.account);
}

export async function handleTestAccountConnection(args, scope) {
  const resolved = await resolvedAccountId(args.account, scope);
  if (resolved.error) return errorResult(resolved.error);
  const account = await getAccountRow(resolved.accountId, scope.accountIds);
  if (!account) return errorResult(`account not found: ${args.account}`);
  const { testConnection } = await import('../services/connectionTest.js');
  return jsonResult({
    account: args.account,
    ...await testConnection(account),
  });
}

function aliasFieldsFrom(args) {
  return {
    name: args.name,
    email: args.email,
    reply_to: args.reply_to,
    signature: args.signature,
  };
}

function aliasValidation(args) {
  if (!args.name || !args.email) return 'Name and email required';
  if (
    hasHeaderInjectionChars(args.name)
    || hasHeaderInjectionChars(args.email)
    || hasHeaderInjectionChars(args.reply_to)
  ) {
    return 'Fields cannot contain control characters';
  }
  return null;
}

export async function handleCreateAlias(args, scope) {
  const validation = aliasValidation(args);
  if (validation) return errorResult(validation);
  const resolved = await resolvedAccountId(args.account, scope);
  if (resolved.error) return errorResult(resolved.error);
  const alias = await createAlias({
    accountId: resolved.accountId,
    accountIds: scope.accountIds,
    userId: scope.userId,
    fields: aliasFieldsFrom(args),
  });
  if (!alias) return errorResult('Account not found');
  return jsonResult(alias);
}

export async function handleUpdateAlias(args, scope) {
  const validation = aliasValidation(args);
  if (validation) return errorResult(validation);
  const resolved = await resolvedAccountId(args.account, scope);
  if (resolved.error) return errorResult(resolved.error);
  const alias = await updateAlias({
    accountId: resolved.accountId,
    accountIds: scope.accountIds,
    userId: scope.userId,
    aliasId: args.alias_id,
    fields: aliasFieldsFrom(args),
  });
  if (!alias) return errorResult('Alias not found');
  return jsonResult(alias);
}

export async function handleDeleteAlias(args, scope) {
  const resolved = await resolvedAccountId(args.account, scope);
  if (resolved.error) return errorResult(resolved.error);
  const deleted = await deleteAlias({
    accountId: resolved.accountId,
    accountIds: scope.accountIds,
    userId: scope.userId,
    aliasId: args.alias_id,
  });
  if (!deleted) return errorResult('Alias not found');
  return jsonResult({ ok: true });
}

export async function handleListRules(args, scope) {
  let accountId;
  if (args.account) {
    const resolved = await resolvedAccountId(args.account, scope);
    if (resolved.error) return errorResult(resolved.error);
    accountId = resolved.accountId;
  }
  return jsonResult({
    rules: await listRules({ userId: scope.userId, accountId }),
  });
}

async function normalizedRuleInput(args, scope) {
  if (!Array.isArray(args.conditions) || !Array.isArray(args.actions)) {
    return { error: 'conditions and actions must be arrays' };
  }
  const conditionError = validateConditions(args.conditions);
  if (conditionError) return { error: conditionError };
  let accountId = null;
  if (args.account_id) {
    const resolved = await resolvedAccountId(args.account_id, scope);
    if (resolved.error) return resolved;
    accountId = resolved.accountId;
  }
  const actions = normalizeActions(args.actions)
    .filter((action) => accountId || action.type !== 'move');
  return {
    accountId,
    name: args.name,
    conditionLogic: args.condition_logic,
    conditions: args.conditions,
    actions,
    enabled: args.enabled,
    stopProcessing: args.stop_processing,
  };
}

export async function handleCreateRule(args, scope) {
  const input = await normalizedRuleInput(args, scope);
  if (input.error) return errorResult(input.error);
  const rule = await createRule({ userId: scope.userId, ...input });
  if (rule?.error) return errorResult(rule.error);
  return jsonResult(rule);
}

export async function handleUpdateRule(args, scope) {
  const input = await normalizedRuleInput(args, scope);
  if (input.error) return errorResult(input.error);
  const rule = await updateRule({
    userId: scope.userId,
    ruleId: args.rule_id,
    ...input,
  });
  if (rule?.error) return errorResult(rule.error);
  if (!rule) return errorResult('Rule not found');
  return jsonResult(rule);
}

export async function handleDeleteRule(args, scope) {
  const deleted = await deleteRule({
    userId: scope.userId,
    ruleId: args.rule_id,
  });
  if (!deleted) return errorResult('Rule not found');
  return jsonResult({ ok: true });
}

export async function handleRunRules(args, scope, deps = {}) {
  let accountIds = scope.accountIds;
  if (args.account) {
    const resolved = await resolveAccountScope(args.account, scope.accountIds);
    if (resolved.error) return errorResult(resolved.error);
    accountIds = resolved.accountIds;
  }
  return jsonResult(await runRules({
    userId: scope.userId,
    accountIds,
    imapManager: deps.imapManager,
  }));
}

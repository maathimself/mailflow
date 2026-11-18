// D#751: the Apply label rule action. A label resolves to a folder of that name in each account,
// is copied before any rule moves the message, and one that could not be applied keeps the message
// in the inbox and is recorded on the rule for that account.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({
  resolveArchiveFolder: vi.fn(),
  isAllMailFolder: vi.fn(),
  resolveTrashFolder: vi.fn(),
  resolveAllTrashPaths: vi.fn(),
  getDeleteStrategy: vi.fn(),
  adjustFolderCounts: vi.fn(),
}));
vi.mock('./labels.js', () => ({ applyLabel: vi.fn() }));

const { query } = await import('./db.js');
const { resolveArchiveFolder, isAllMailFolder } = await import('../utils/mailUtils.js');
const { applyLabel } = await import('./labels.js');
const { applyInboxRules, labelNameError, MAX_LABEL_NAME_LENGTH } = await import('./inboxRules.js');

const account = { id: 'acc-1', user_id: 'user-1', folder_mappings: {} };
const mkMsg = (overrides = {}) => ({
  id: 'msg-1', uid: 100, folder: 'INBOX', account_id: 'acc-1', messageId: '<m1@example.com>',
  fromEmail: 'shop@example.com', fromName: 'Shop', to: [], subject: 'Your receipt',
  is_read: false, hasAttachments: false, parsedHeaders: {},
  ...overrides,
});
const mkRule = (actions, overrides = {}) => ({
  id: 'rule-1', user_id: 'user-1', account_id: null, enabled: true, stop_processing: false,
  condition_logic: 'AND', conditions: [{ field: 'from', operator: 'contains', value: 'shop@' }],
  actions, label_failures: {},
  ...overrides,
});
const imap = {
  ensureFolder: vi.fn(),
  bulkMoveMessages: vi.fn(),
  setFlag: vi.fn(),
  _guardMoveUid: vi.fn(),
  _unguardMoveUid: vi.fn(),
  syncFolderOnDemand: vi.fn(),
};
const sqlCalls = (re) => query.mock.calls.filter(([sql]) => re.test(sql));
// Every query after the rules load answers with no rows unless a test says otherwise.
const loadRules = (rules) => query.mockImplementation(async (sql) => {
  if (/FROM inbox_rules/.test(sql) && /SELECT/.test(sql)) return { rows: rules };
  if (/SELECT message_id FROM messages/.test(sql)) return { rows: [{ message_id: '<loaded@example.com>' }] };
  return { rows: [], rowCount: 1 };
});

beforeEach(() => {
  vi.clearAllMocks();
  imap.ensureFolder.mockResolvedValue({ path: 'INBOX.Receipt', created: false });
  imap.syncFolderOnDemand.mockResolvedValue(undefined);
  imap.bulkMoveMessages.mockResolvedValue({ failed: [], uidMap: new Map([[100, 7]]) });
  applyLabel.mockResolvedValue({ applied: true, uid: 9 });
  resolveArchiveFolder.mockResolvedValue('Archive');
  isAllMailFolder.mockResolvedValue(false);
});

describe('Apply label', () => {
  it("copies the message into the label's folder in this account, resolved once per run", async () => {
    loadRules([mkRule([{ type: 'apply_label', value: ' Receipt ' }])]);
    const msgs = [mkMsg(), mkMsg({ id: 'msg-2', uid: 101, messageId: '<m2@example.com>' })];
    const result = await applyInboxRules(msgs, account, imap);
    expect(imap.ensureFolder).toHaveBeenCalledTimes(1);
    expect(imap.ensureFolder).toHaveBeenCalledWith(account, 'Receipt', { resolvePath: true });
    expect(applyLabel).toHaveBeenCalledTimes(2);
    expect(applyLabel).toHaveBeenCalledWith(imap, account,
      { uid: 100, folder: 'INBOX', message_id: '<m1@example.com>', account_id: 'acc-1' }, 'INBOX.Receipt');
    expect(result.remaining).toHaveLength(2);
    expect(sqlCalls(/label_failures/)).toHaveLength(0);
  });

  it('loads the Message-ID when the message comes from a run over the inbox without one', async () => {
    loadRules([mkRule([{ type: 'apply_label', value: 'Receipt' }])]);
    const swept = mkMsg();
    delete swept.messageId;
    await applyInboxRules([swept], account, imap);
    expect(sqlCalls(/SELECT message_id FROM messages/)).toHaveLength(1);
    expect(applyLabel.mock.calls[0][2].message_id).toBe('<loaded@example.com>');
  });

  it('labels before archiving, and archives once the label is on', async () => {
    loadRules([mkRule([{ type: 'archive', value: '' }, { type: 'apply_label', value: 'Receipt' }])]);
    const result = await applyInboxRules([mkMsg()], account, imap);
    expect(applyLabel.mock.invocationCallOrder[0]).toBeLessThan(imap.bulkMoveMessages.mock.invocationCallOrder[0]);
    expect(applyLabel.mock.calls[0][2].folder).toBe('INBOX');
    expect(result.remaining).toHaveLength(0);
  });

  it('a label in a later rule still goes on before an earlier rule archives', async () => {
    loadRules([
      mkRule([{ type: 'archive', value: '' }], { id: 'rule-archive' }),
      mkRule([{ type: 'apply_label', value: 'Receipt' }], { id: 'rule-label' }),
    ]);
    await applyInboxRules([mkMsg()], account, imap);
    expect(applyLabel.mock.invocationCallOrder[0]).toBeLessThan(imap.bulkMoveMessages.mock.invocationCallOrder[0]);
    expect(applyLabel.mock.calls[0][2].folder).toBe('INBOX', 'copied from the inbox, not after the move');
  });

  it('a label that fails keeps the message in the inbox and records why for this account', async () => {
    loadRules([mkRule([{ type: 'apply_label', value: 'Receipt' }, { type: 'archive', value: '' }])]);
    applyLabel.mockRejectedValue(new Error('NO [OVERQUOTA] mailbox full'));
    const result = await applyInboxRules([mkMsg()], account, imap);
    expect(imap.bulkMoveMessages).not.toHaveBeenCalled();
    expect(result.remaining).toHaveLength(1);
    const [[sql, params]] = sqlCalls(/jsonb_set/);
    expect(sql).toMatch(/UPDATE inbox_rules/);
    expect(params[0]).toBe('rule-1');
    expect(params[1]).toBe('acc-1');
    expect(JSON.parse(params[2])).toMatchObject({ label: 'Receipt', error: 'NO [OVERQUOTA] mailbox full', subject: 'Your receipt' });
  });

  it("an earlier rule's archive waits for a later label and is held back when it fails", async () => {
    loadRules([
      mkRule([{ type: 'archive', value: '' }], { id: 'rule-archive' }),
      mkRule([{ type: 'apply_label', value: 'Receipt' }], { id: 'rule-label' }),
    ]);
    applyLabel.mockRejectedValue(new Error('copy failed'));
    const result = await applyInboxRules([mkMsg()], account, imap);
    expect(imap.bulkMoveMessages).not.toHaveBeenCalled();
    expect(result.remaining).toHaveLength(1);
  });

  it('a folder that cannot be created fails every message, asking the server once', async () => {
    loadRules([mkRule([{ type: 'apply_label', value: 'Receipt' }])]);
    imap.ensureFolder.mockRejectedValue(new Error('NO [CANNOT] Permission denied'));
    await applyInboxRules([mkMsg(), mkMsg({ id: 'msg-2', uid: 101, messageId: '<m2@example.com>' })], account, imap);
    expect(imap.ensureFolder).toHaveBeenCalledTimes(1);
    expect(applyLabel).not.toHaveBeenCalled();
    expect(sqlCalls(/jsonb_set/)).toHaveLength(1);
    expect(JSON.parse(sqlCalls(/jsonb_set/)[0][1][2]).error).toBe('NO [CANNOT] Permission denied');
  });

  it('leaves a message without a Message-ID unlabelled, saying why, and in the inbox', async () => {
    loadRules([mkRule([{ type: 'apply_label', value: 'Receipt' }, { type: 'archive', value: '' }])]);
    await applyInboxRules([mkMsg({ messageId: null })], account, imap);
    expect(applyLabel).not.toHaveBeenCalled();
    expect(imap.bulkMoveMessages).not.toHaveBeenCalled();
    expect(JSON.parse(sqlCalls(/jsonb_set/)[0][1][2]).error).toMatch(/no Message-ID/);
  });

  it("clears this account's recorded failure once a label goes on, and leaves other accounts'", async () => {
    loadRules([mkRule([{ type: 'apply_label', value: 'Receipt' }], {
      label_failures: { 'acc-1': { error: 'old' }, 'acc-2': { error: 'other' } },
    })]);
    await applyInboxRules([mkMsg()], account, imap);
    const [[sql, params]] = sqlCalls(/label_failures - /);
    expect(sql).toMatch(/UPDATE inbox_rules SET label_failures = label_failures - \$2::text/);
    expect(params).toEqual(['rule-1', 'acc-1']);
  });

  it('writes nothing for a rule with no failure on record and none now', async () => {
    loadRules([mkRule([{ type: 'apply_label', value: 'Receipt' }])]);
    await applyInboxRules([mkMsg()], account, imap);
    expect(sqlCalls(/UPDATE inbox_rules/)).toHaveLength(0);
  });

  it('a stored label name the rules refuse fails without touching the server', async () => {
    loadRules([mkRule([{ type: 'apply_label', value: 'INBOX' }, { type: 'archive', value: '' }])]);
    await applyInboxRules([mkMsg()], account, imap);
    expect(imap.ensureFolder).not.toHaveBeenCalled();
    expect(imap.bulkMoveMessages).not.toHaveBeenCalled();
    expect(JSON.parse(sqlCalls(/jsonb_set/)[0][1][2]).error).toBe('A label cannot be named INBOX');
  });
});

describe('labelNameError', () => {
  it.each(['Receipt', 'Receipts/2026', 'Paid · 2026', 'Projekt Ä', 'x'.repeat(MAX_LABEL_NAME_LENGTH)])('accepts %j', (name) => {
    expect(labelNameError(name)).toBe(null);
  });
  it.each([
    ['', 'Apply label needs a label name'],
    ['   ', 'Apply label needs a label name'],
    [undefined, 'Apply label needs a label name'],
    ['x'.repeat(MAX_LABEL_NAME_LENGTH + 1), 'Label names can be at most 100 characters'],
    ['Re*', 'Label names cannot contain *, %, \\ or control characters'],
    ['50%', 'Label names cannot contain *, %, \\ or control characters'],
    ['a\\b', 'Label names cannot contain *, %, \\ or control characters'],
    ['a\nb', 'Label names cannot contain *, %, \\ or control characters'],
    ['/Receipt', 'Label names cannot start or end with /, or have an empty part'],
    ['Receipt/', 'Label names cannot start or end with /, or have an empty part'],
    ['A//B', 'Label names cannot start or end with /, or have an empty part'],
    ['A/../B', 'Label names cannot start or end with /, or have an empty part'],
    ['inbox', 'A label cannot be named INBOX'],
    ['INBOX/Receipt', 'A label cannot be named INBOX'],
  ])('refuses %j', (name, message) => {
    expect(labelNameError(name)).toBe(message);
  });
});

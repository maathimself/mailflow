import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCommandContext, validateCommandDefinition } from './contracts.js';
import { hasTargets, resolveTargetIds } from './targets.js';

const command = targetMode => validateCommandDefinition({
  id: `test.${targetMode}`,
  titleKey: 'test.title', aliasKeys: [], icon: 'test', group: 'test',
  defaultKeys: { primary: null, secondary: [] }, rank: { base: 0 },
  isAvailable: () => true, targetMode, executorId: 'test.execute',
});
const context = overrides => createCommandContext({
  surface: 'list', activeConversationId: null, selectedConversationIds: [],
  conversations: [
    { id: 'row-a', message_id: '<a>', account_id: 'acct' },
    { id: 'row-b', message_id: '<b>', account_id: 'acct' },
  ],
  accountId: 'acct', folder: 'INBOX', draft: null, gtdAvailable: false,
  cardDavConnected: false, modal: null, editing: false, platform: 'linux',
  shortcutOverrides: {}, translate: key => key, ...overrides,
});

describe('command targets', () => {
  it('omits conversation commands without an active row or checkbox selection', () => {
    assert.equal(hasTargets(command('single_conversation'), context({})), false);
    assert.equal(hasTargets(command('bulk_safe'), context({})), false);
  });

  it('makes single and bulk-safe commands available for one active conversation', () => {
    const ctx = context({ activeConversationId: 'acct:<a>' });
    assert.equal(hasTargets(command('single_conversation'), ctx), true);
    assert.deepEqual(resolveTargetIds(command('bulk_safe'), ctx), {
      targetIds: ['acct:<a>'], missingTargetIds: [],
    });
  });

  it('uses the complete selection and hides single-conversation commands in bulk', () => {
    const ctx = context({ activeConversationId: 'acct:<a>', selectedConversationIds: ['acct:<a>', 'acct:<b>'] });
    assert.equal(hasTargets(command('single_conversation'), ctx), false);
    assert.deepEqual(resolveTargetIds(command('bulk_safe'), ctx).targetIds, ['acct:<a>', 'acct:<b>']);
  });

  it('re-resolves a frozen continuation target set and reports missing targets', () => {
    assert.deepEqual(resolveTargetIds(command('bulk_safe'), context({}), ['acct:<a>', 'acct:<gone>']), {
      targetIds: ['acct:<a>'], missingTargetIds: ['acct:<gone>'],
    });
  });

  it('requires current account and draft state for their scoped modes', () => {
    assert.equal(hasTargets(command('account'), context({ accountId: null })), false);
    assert.equal(hasTargets(command('account'), context({ accountId: 'acct' })), true);
    assert.equal(hasTargets(command('draft'), context({ draft: null })), false);
    assert.equal(hasTargets(command('draft'), context({ draft: { id: 'draft-1' } })), true);
  });

  it('targets draft commands by session id without editor content', () => {
    const ctx = context({ draft: { id: 'draft-1', subject: 'private editor content' } });
    assert.deepEqual(resolveTargetIds(command('draft'), ctx), {
      targetIds: ['draft-1'], missingTargetIds: [],
    });
    assert.deepEqual(resolveTargetIds(command('draft'), ctx, ['draft-2']), {
      targetIds: [], missingTargetIds: ['draft-2'],
    });
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TARGET_MODES,
  createCommandContext,
  stableConversationId,
  validateCommandDefinition,
} from './contracts.js';

const validDefinition = {
  id: 'mail.archive',
  titleKey: 'commands.mail.archive.title',
  aliasKeys: ['commands.mail.archive.alias.done'],
  icon: 'archive',
  group: 'mail',
  defaultKeys: { primary: 'e', secondary: ['o'] },
  rank: { base: 100, boost: context => context.selectedConversationIds.length ? 25 : 0 },
  isAvailable: context => context.surface !== 'settings',
  targetMode: 'bulk_safe',
  executorId: 'mail.archive',
};

describe('command contracts', () => {
  it('uses the five approved target-mode values', () => {
    assert.deepEqual(Object.values(TARGET_MODES), [
      'global', 'account', 'draft', 'single_conversation', 'bulk_safe',
    ]);
  });

  it('validates and deeply freezes a complete definition', () => {
    const definition = validateCommandDefinition(validDefinition);
    assert.equal(definition.id, 'mail.archive');
    assert.ok(Object.isFrozen(definition));
    assert.ok(Object.isFrozen(definition.aliasKeys));
    assert.ok(Object.isFrozen(definition.defaultKeys.secondary));
    assert.throws(() => definition.aliasKeys.push('commands.other'));
  });

  it('rejects missing, unnamespaced, and unsupported fields with exact errors', () => {
    assert.throws(
      () => validateCommandDefinition({ ...validDefinition, id: 'archive' }),
      /command id must be namespaced/,
    );
    assert.throws(
      () => validateCommandDefinition({ ...validDefinition, targetMode: 'message' }),
      /unsupported targetMode "message"/,
    );
    assert.throws(
      () => validateCommandDefinition({ ...validDefinition, executorId: '' }),
      /executorId must be a non-empty string/,
    );
  });

  it('scopes RFC Message-ID and row-id fallback identities by account', () => {
    assert.equal(stableConversationId({ account_id: 'acct-1', id: 'row-1', message_id: '<same@example.test>' }), 'acct-1:<same@example.test>');
    assert.equal(stableConversationId({ account_id: 'acct-2', id: 'row-1', message_id: '<same@example.test>' }), 'acct-2:<same@example.test>');
    assert.equal(stableConversationId({ account_id: 'acct-1', id: 'row-2' }), 'acct-1:row-2');
    assert.equal(stableConversationId({ id: 'row-2' }), null);
    assert.equal(stableConversationId({}), null);
  });

  it('normalizes and freezes a complete command context snapshot', () => {
    const context = createCommandContext({
      surface: 'list',
      activeConversationId: 'acct-1:<active@example.test>',
      activeMessage: { id: 'row-a', message_id: '<active@example.test>', account_id: 'acct-1' },
      selectedConversationIds: ['acct-1:<bulk@example.test>', 'acct-1:<bulk@example.test>'],
      visibleConversationIds: ['acct-1:<active@example.test>', 'acct-1:<bulk@example.test>'],
      conversations: [
        { id: 'row-a', message_id: '<active@example.test>', account_id: 'acct-1' },
        { id: 'row-b', message_id: '<bulk@example.test>', account_id: 'acct-1' },
      ],
      accountId: 'acct-1',
      folder: 'INBOX',
      draft: null,
      gtdAvailable: true,
      cardDavConnected: false,
      modal: null,
      editing: false,
      undoAvailable: true,
      platform: 'mac',
      shortcutOverrides: { 'mail.archive': 'x' },
      translate: key => ({ 'commands.mail.archive.title': 'Archive' })[key] || key,
    });

    assert.deepEqual(context.selectedConversationIds, ['acct-1:<bulk@example.test>']);
    assert.deepEqual(context.visibleConversationIds, ['acct-1:<active@example.test>', 'acct-1:<bulk@example.test>']);
    assert.equal(context.conversationsById['acct-1:<active@example.test>'].rowId, 'row-a');
    assert.equal(context.activeMessage.id, 'row-a');
    assert.equal(context.undoAvailable, true);
    assert.equal(context.translate('commands.mail.archive.title'), 'Archive');
    assert.ok(Object.isFrozen(context));
    assert.ok(Object.isFrozen(context.selectedConversationIds));
  });

  it('preserves the legacy CardDAV boolean while exposing a frozen status snapshot', () => {
    const context = createCommandContext({
      surface: 'list', platform: 'linux', translate: key => key,
      cardDavConnected: true,
    });
    assert.equal(context.cardDavConnected, true);
    assert.deepEqual(context.carddavStatus, { connected: true });
    assert.ok(Object.isFrozen(context.carddavStatus));
  });
});

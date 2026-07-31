import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCommandContext, validateCommandDefinition } from './contracts.js';
import { rankCommands } from './search.js';

const make = (id, titleKey, aliasKeys, base, boost = () => 0) => validateCommandDefinition({
  id, titleKey, aliasKeys, icon: 'test', group: 'test',
  defaultKeys: { primary: null, secondary: [] }, rank: { base, boost },
  isAvailable: () => true, targetMode: 'global', executorId: id,
});
const strings = {
  archive: 'Archive', done: 'Done', compose: 'Compose', search: 'Search', settings: 'Settings',
};
const context = createCommandContext({
  surface: 'list', activeConversationId: null, selectedConversationIds: [], conversations: [],
  accountId: null, folder: null, draft: null, gtdAvailable: false, cardDavConnected: false,
  modal: null, editing: false, platform: 'mac', shortcutOverrides: {},
  translate: key => strings[key] || key,
});
const archive = make('mail.archive', 'archive', ['done'], 50, ctx => ctx.selectedConversationIds.length ? 30 : 0);
const compose = make('compose.new', 'compose', [], 60);
const settings = make('settings.open', 'settings', [], 10);

describe('rankCommands', () => {
  it('finds case-insensitive title matches', () => {
    assert.equal(rankCommands([archive, compose], 'ARCHIVE', context)[0].command.id, 'mail.archive');
  });

  it('keeps the Mailflow title and discloses the matching alias', () => {
    const [result] = rankCommands([archive, compose], 'done', context);
    assert.equal(result.title, 'Archive');
    assert.equal(result.matchedAlias, 'Done');
    assert.equal(result.matchedAliasKey, 'done');
  });

  it('tolerates a close transposition misspelling', () => {
    assert.equal(rankCommands([archive, compose], 'arhcive', context)[0].command.id, 'mail.archive');
  });

  it('uses stable base priority for an empty query', () => {
    assert.deepEqual(rankCommands([settings, compose, archive], '', context).map(x => x.command.id), [
      'compose.new', 'mail.archive', 'settings.open',
    ]);
  });

  it('adds contextual boost and preserves definition order for exact ties', () => {
    const selected = { ...context, selectedConversationIds: ['acct:<a>'] };
    const equalA = make('navigation.a', 'search', [], 1);
    const equalB = make('navigation.b', 'search', [], 1);
    assert.equal(rankCommands([compose, archive], '', selected)[0].command.id, 'mail.archive');
    assert.deepEqual(rankCommands([equalA, equalB], 'search', context).map(x => x.command.id), [
      'navigation.a', 'navigation.b',
    ]);
  });
});

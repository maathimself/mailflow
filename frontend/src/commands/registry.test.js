import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCommandContext } from './contracts.js';
import { createCommandRegistry } from './registry.js';

const raw = (id, overrides = {}) => ({
  id, titleKey: `${id}.title`, aliasKeys: [], icon: 'test', group: 'test',
  defaultKeys: { primary: null, secondary: [] }, rank: { base: 0 },
  isAvailable: () => true, targetMode: 'global', executorId: id, ...overrides,
});
const context = createCommandContext({
  surface: 'list', activeConversationId: null, selectedConversationIds: [], conversations: [],
  accountId: null, folder: null, draft: null, gtdAvailable: false, cardDavConnected: false,
  modal: null, editing: false, platform: 'mac', shortcutOverrides: {}, translate: key => key,
});

describe('createCommandRegistry', () => {
  it('rejects duplicate IDs before exposing a partial registry', () => {
    assert.throws(() => createCommandRegistry([raw('test.one'), raw('test.one')]), /duplicate command id "test.one"/);
  });

  it('returns definitions by ID without exposing mutation', () => {
    const registry = createCommandRegistry([raw('test.one')]);
    assert.equal(registry.get('test.one').executorId, 'test.one');
    assert.equal(registry.get('test.missing'), null);
    assert.ok(Object.isFrozen(registry.get('test.one')));
  });

  it('omits explicit and target-mode-unavailable commands', () => {
    const registry = createCommandRegistry([
      raw('global.visible'),
      raw('global.hidden', { isAvailable: () => false }),
      raw('mail.archive', { targetMode: 'bulk_safe' }),
    ]);
    assert.deepEqual(registry.list(context).map(entry => entry.command.id), ['global.visible']);
  });

  it('returns effective bindings and localized alias search metadata', () => {
    const registry = createCommandRegistry([raw('mail.archive', {
      titleKey: 'archive', aliasKeys: ['done'], defaultKeys: { primary: 'e', secondary: [] },
    })]);
    const localized = { ...context, translate: key => ({ archive: 'Archive', done: 'Done' })[key] || key };
    const [result] = registry.search('done', localized);
    assert.equal(result.title, 'Archive');
    assert.equal(result.matchedAlias, 'Done');
    assert.deepEqual(result.bindings, [{ key: 'e', kind: 'primary' }]);
  });
});

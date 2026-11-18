import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as hotkeys from './messageHotkeys.js';

const selectedMessage = hotkeys.selectedMessage ?? (() => null);
const markMessageUnread = hotkeys.markMessageUnread ?? (() => false);

describe('selected message hotkeys', () => {
  const inbox = { id: 'inbox', account_id: 'acct', folder: 'INBOX', is_read: true, category: 'primary' };
  const rail = { id: 'rail', account_id: 'acct', is_read: true };

  it('resolves normal, search, thread, and GTD rail selections; no selection is a no-op', () => {
    assert.equal(selectedMessage({ selectedMessageId: 'inbox', messages: [inbox], searchResults: [], searchQuery: '', threadMessages: {} }), inbox);
    assert.equal(selectedMessage({ selectedMessageId: 'rail', messages: [inbox], searchResults: [], searchQuery: '', threadMessages: {}, gtdSections: { todo: { threads: [rail] } } }), rail);
    assert.equal(selectedMessage({ selectedMessageId: 'rail', messages: [], searchResults: [rail], searchQuery: 'q', threadMessages: {} }), rail);
    assert.equal(selectedMessage({ selectedMessageId: null, messages: [inbox] }), null);
  });

  it('uses the frontmost open message window when the main list has no selection', () => {
    const behind = { id: 'behind', account_id: 'acct' };
    const front = { id: 'front', account_id: 'acct' };
    const state = {
      selectedMessageId: null, messages: [behind, front],
      messageWindows: [
        { messageId: 'behind', z: 3, minimized: false },
        { messageId: 'front', z: 5, minimized: false },
      ],
    };
    assert.equal(selectedMessage(state), front);
    assert.equal(selectedMessage({ ...state, messageWindows: state.messageWindows.map(w => ({ ...w, minimized: true })) }), null);
  });

  it('explicit unread cancels a pending auto-read, even if row is still unread', async () => {
    const calls = [];
    const cancel = () => calls.push('cancel');
    const patch = async (ids, read) => calls.push(['patch', ids, read]);
    assert.equal(markMessageUnread({ ...inbox, is_read: false }, { cancel, patch }), true);
    assert.deepEqual(calls, ['cancel']);
    assert.equal(markMessageUnread(inbox, {
      cancel,
      update: (id, data) => calls.push(['update', id, data]),
      incrementUnread: () => calls.push('increment'),
      adjustCategoryCount: () => calls.push('category'),
      patch,
    }), true);
    await Promise.resolve();
    assert.deepEqual(calls.slice(1), ['cancel', ['update', 'inbox', { is_read: false }], 'increment', 'category', ['patch', ['inbox'], false]]);
  });

  it('marking a message outside INBOX unread leaves the badge and categories alone, failure included', async () => {
    const calls = [];
    const archived = { ...inbox, id: 'arch', folder: 'Archive' };
    markMessageUnread(archived, {
      update: (id, data) => calls.push(['update', id, data]),
      incrementUnread: () => calls.push('increment'),
      decrementUnread: () => calls.push('decrement'),
      adjustCategoryCount: () => calls.push('category'),
      patch: async () => { throw new Error('network'); },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(calls, [['update', 'arch', { is_read: false }], ['update', 'arch', { is_read: true }]]);
  });
});

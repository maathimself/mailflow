import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { conversationListParams, resolveConversationMode } from './conversationMode.js';

describe('resolveConversationMode', () => {
  it('prefers a valid conversationMode', () => {
    assert.equal(resolveConversationMode({ conversationMode: 'pane', threadedView: false }), 'pane');
  });

  it('maps legacy threadedView values', () => {
    assert.equal(resolveConversationMode({ threadedView: true }), 'list');
    assert.equal(resolveConversationMode({ threadedView: false }), 'off');
  });

  it('falls back to off', () => {
    assert.equal(resolveConversationMode({ conversationMode: 'invalid' }), 'off');
  });
});

describe('conversationListParams', () => {
  it('does not group messages in off mode', () => {
    assert.deepEqual(conversationListParams('off'), {});
  });

  it('uses folder-scoped grouping in list mode', () => {
    assert.deepEqual(conversationListParams('list'), { threaded: 'true' });
  });

  it('uses all-folder grouping in pane mode', () => {
    assert.deepEqual(conversationListParams('pane'), { threaded: 'true', threadScope: 'all' });
  });
});

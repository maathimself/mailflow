import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConversationMode } from './conversationMode.js';

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

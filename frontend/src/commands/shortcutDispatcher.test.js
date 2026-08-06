import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createShortcutDispatcher } from './shortcutDispatcher.js';

const event = (key, patch = {}) => ({
  key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
  target: { tagName: 'DIV', isContentEditable: false }, prevented: false,
  preventDefault() { this.prevented = true; }, ...patch,
});

function harness(context, available, bindings) {
  const calls = [];
  const scheduled = [];
  const dispatcher = createShortcutDispatcher({
    registry: { list: () => available.map(command => ({ command, title: command.id, score: 0, bindings: [] })) },
    getContext: () => context,
    getBindings: () => bindings, execute: (id, options) => calls.push([id, options]),
    timers: { setTimeout(fn, ms) { const item = { fn, ms }; scheduled.push(item); return item; }, clearTimeout() {} },
  });
  return { calls, scheduled, dispatcher };
}

describe('shortcut dispatcher', () => {
  it('resolves contextual Enter by availability and rank', () => {
    const h = harness({ surface: 'list', modal: null, editing: false }, [
      { id: 'navigation.openConversation', rank: { base: 100 } },
    ], [
      { commandId: 'navigation.openConversation', bindings: [{ keys: 'enter' }] },
      { commandId: 'mail.replyAll', bindings: [{ keys: 'enter' }] },
    ]);
    h.dispatcher.handleKeyDown(event('Enter'));
    assert.equal(h.calls[0][0], 'navigation.openConversation');
  });

  it('dispatches a one-second sequence and cancels it on Escape', () => {
    const h = harness({ surface: 'list', modal: null, editing: false }, [
      { id: 'navigation.inbox', rank: { base: 40 } },
    ], [{ commandId: 'navigation.inbox', bindings: [{ keys: 'g i' }] }]);
    const first = event('g');
    h.dispatcher.handleKeyDown(first);
    assert.equal(h.scheduled[0].ms, 1000);
    h.dispatcher.handleKeyDown(event('i'));
    assert.equal(h.calls[0][0], 'navigation.inbox');
    h.dispatcher.handleKeyDown(event('g'));
    h.dispatcher.handleKeyDown(event('Escape'));
    h.dispatcher.handleKeyDown(event('i'));
    assert.equal(h.calls.length, 1);
  });

  it('normalizes modifiers and yields to typing, modals, and IME composition', () => {
    const available = [{ id: 'mail.unsubscribe', rank: { base: 50 } }];
    const bindings = [{ commandId: 'mail.unsubscribe', bindings: [{ keys: 'meta+u' }] }];
    const h = harness({ surface: 'conversation', modal: null, editing: false }, available, bindings);
    h.dispatcher.handleKeyDown(event('u', { metaKey: true }));
    h.dispatcher.handleKeyDown(event('u', { metaKey: true, target: { tagName: 'INPUT' } }));
    h.dispatcher.handleKeyDown(event('u', { metaKey: true, isComposing: true }));
    assert.equal(h.calls.length, 1);
  });
});

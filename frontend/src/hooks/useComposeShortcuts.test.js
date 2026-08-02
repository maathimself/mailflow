import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCommandController } from '../commands/controller.js';
import { createCommandRegistry } from '../commands/registry.js';
import {
  composeSessionCommandDefinitions,
  createComposeSessionCommandExecutors,
} from '../commands/composeSessionCommands.js';
import { createComposeShortcutHandler } from './useComposeShortcuts.js';
import { createComposeEscapeOwnerRegistry } from '../compose/escapeOwners.js';
import { composeModalKeyAction, handleComposeModalKeyDown } from '../compose/keyboard.js';

const workspaceSource = fs.readFileSync(new URL('../components/ComposeWorkspace.jsx', import.meta.url), 'utf8');

function element({ sessionId = null, escapeOwner = false } = {}) {
  const composer = sessionId ? { getAttribute: name => name === 'data-compose-session-id' ? sessionId : null } : null;
  return {
    closest(selector) {
      if (selector === '[data-compose-escape-owner]') return escapeOwner ? {} : null;
      if (selector === '[data-compose-session-id]') return composer;
      return null;
    },
  };
}

function keyboard(key, overrides = {}) {
  let prevented = false;
  return {
    key,
    target: element(),
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 0,
    preventDefault() { prevented = true; },
    get defaultPrevented() { return prevented; },
    ...overrides,
  };
}

function context(sessions, focusedSessionId = null) {
  const focused = sessions.find(session => session.id === focusedSessionId);
  return {
    surface: focused ? 'compose' : 'list',
    draft: focused ? { id: focused.id, slot: focused.slot } : null,
    composeSlots: sessions,
    accountId: null,
    activeConversationId: null,
    selectedConversationIds: [],
    conversationsById: {},
    platform: 'linux',
    shortcutOverrides: {},
    translate: key => key,
  };
}

function harness({
  sessions, visibleSessions = sessions, focusedSessionId = null,
  dismissEscapeOwner = () => false,
}) {
  const calls = [];
  const registry = createCommandRegistry(composeSessionCommandDefinitions);
  const handler = createComposeShortcutHandler({
    commandController: {
      execute(commandId, options) {
        calls.push([commandId, options]);
        return Promise.resolve({ status: 'success' });
      },
    },
    registry,
    getContext: () => context(sessions, focusedSessionId),
    getSessions: () => sessions,
    getVisibleSessions: () => visibleSessions,
    getFocusedSessionId: () => focusedSessionId,
    dismissEscapeOwner,
  });
  return { calls, handler };
}

describe('compose shortcut capture', () => {
  it('mounts one workspace shortcut owner', () => {
    assert.equal((workspaceSource.match(/useComposeShortcuts\(\{/g) || []).length, 1);
  });

  it('prevents Cmd/Ctrl+W only inside a composer and minimizes that DOM-owned session', () => {
    const sessions = [{ id: 'session-1', slot: 1, presentationState: 'expanded' }];
    for (const modifier of ['metaKey', 'ctrlKey']) {
      const inside = harness({ sessions, focusedSessionId: 'session-1' });
      const event = keyboard('w', { [modifier]: true, target: element({ sessionId: 'session-1' }) });
      assert.equal(inside.handler(event), true);
      assert.equal(event.defaultPrevented, true);
      assert.deepEqual(inside.calls, [['compose.minimize', {
        source: 'compose-shortcut', input: { sessionId: 'session-1' },
      }]]);
    }

    const outside = harness({ sessions, focusedSessionId: 'session-1' });
    const event = keyboard('w', { ctrlKey: true, target: element() });
    assert.equal(outside.handler(event), false);
    assert.equal(event.defaultPrevented, false);
    assert.deepEqual(outside.calls, []);
  });

  it('minimizes the focused composer or the leftmost visible composer on Shift+Escape', () => {
    const sessions = [
      { id: 'left', slot: 1, presentationState: 'expanded' },
      { id: 'focused', slot: 2, presentationState: 'expanded' },
    ];
    const focused = harness({ sessions, focusedSessionId: 'focused' });
    const focusedEvent = keyboard('Escape', { shiftKey: true });
    focused.handler(focusedEvent);
    assert.equal(focused.calls[0][1].input.sessionId, 'focused');

    const fallback = harness({
      sessions,
      visibleSessions: sessions,
      focusedSessionId: null,
    });
    const fallbackEvent = keyboard('Escape', { shiftKey: true });
    fallback.handler(fallbackEvent);
    assert.equal(fallback.calls[0][0], 'compose.activateSlot1');
    assert.equal(fallback.calls[1][0], 'compose.minimize');
    assert.equal(fallback.calls[1][1].input.sessionId, 'left');
    assert.equal(fallbackEvent.defaultPrevented, true);
  });

  it('safely closes the focused or most-recently-focused visible composer on Escape', () => {
    const sessions = [
      { id: 'older', slot: 1, presentationState: 'expanded', lastFocusedAt: '2026-01-01T00:00:00Z' },
      { id: 'recent', slot: 2, presentationState: 'expanded', lastFocusedAt: '2026-01-03T00:00:00Z' },
    ];
    const focused = harness({ sessions, focusedSessionId: 'older' });
    focused.handler(keyboard('Escape'));
    assert.equal(focused.calls[0][0], 'compose.close');
    assert.equal(focused.calls[0][1].input.sessionId, 'older');

    const fallback = harness({ sessions, focusedSessionId: null });
    fallback.handler(keyboard('Escape'));
    assert.equal(fallback.calls[0][0], 'compose.activateSlot2');
    assert.equal(fallback.calls[1][0], 'compose.close');
    assert.equal(fallback.calls[1][1].input.sessionId, 'recent');
  });

  it('lets a local escape owner consume Escape before safe close', () => {
    const sessions = [{ id: 'session-1', slot: 1, presentationState: 'expanded' }];
    const dismissed = [];
    const { calls, handler } = harness({
      sessions,
      focusedSessionId: 'session-1',
      dismissEscapeOwner: sessionId => { dismissed.push(sessionId); return true; },
    });
    const event = keyboard('Escape', {
      target: element({ sessionId: 'session-1', escapeOwner: true }),
    });
    assert.equal(handler(event), true);
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(dismissed, ['session-1']);
    assert.deepEqual(calls, []);
  });

  it('dismisses the top compose-local owner even when focus remains in the editor', () => {
    const sessions = [{ id: 'session-1', slot: 1, presentationState: 'expanded' }];
    const registry = createComposeEscapeOwnerRegistry();
    const dismissed = [];
    registry.register({ sessionId: 'session-1', priority: 10, dismiss: () => dismissed.push('toolbar') });
    const unregisterDialog = registry.register({
      sessionId: 'session-1', priority: 20, dismiss: () => dismissed.push('dialog'),
    });
    registry.register({ sessionId: 'session-2', priority: 99, dismiss: () => dismissed.push('other') });
    const calls = [];
    const handler = createComposeShortcutHandler({
      commandController: { execute: (...args) => calls.push(args) },
      registry: createCommandRegistry(composeSessionCommandDefinitions),
      getContext: () => context(sessions, 'session-1'),
      getSessions: () => sessions,
      getVisibleSessions: () => sessions,
      getFocusedSessionId: () => 'session-1',
      dismissEscapeOwner: sessionId => registry.dismissTop(sessionId),
    });
    const editorEvent = keyboard('Escape', { target: element({ sessionId: 'session-1' }) });
    assert.equal(handler(editorEvent), true);
    assert.deepEqual(dismissed, ['dialog']);
    assert.deepEqual(calls, []);
    unregisterDialog();
    const siblingButtonEvent = keyboard('Escape', { target: element({ sessionId: 'session-1' }) });
    assert.equal(handler(siblingButtonEvent), true);
    assert.deepEqual(dismissed, ['dialog', 'toolbar']);
    assert.deepEqual(calls, []);
    registry.clear();
    assert.equal(handler(keyboard('Escape', { target: element({ sessionId: 'session-1' }) })), true);
    assert.equal(calls[0][0], 'compose.close');
  });

  it('ignores modal send and overlay dismissal during IME, then handles ordinary keys once', () => {
    for (const event of [
      keyboard('Enter', { ctrlKey: true, isComposing: true }),
      keyboard('Escape', { keyCode: 229 }),
    ]) assert.equal(composeModalKeyAction(event, { localEscapeOwned: true }), 'ignore');
    assert.equal(composeModalKeyAction(keyboard('Enter', { ctrlKey: true })), 'send');
    assert.equal(composeModalKeyAction(keyboard('Escape'), { localEscapeOwned: true }), 'dismiss-overlay');
    assert.equal(composeModalKeyAction(keyboard('Escape')), null);
  });

  it('stops modal send propagation so the shared dispatcher cannot send twice', () => {
    const calls = [];
    const event = keyboard('Enter', {
      ctrlKey: true,
      stopPropagation: () => calls.push('stopped'),
    });
    assert.equal(handleComposeModalKeyDown(event, {
      send: () => calls.push('sent'),
      dismissOverlay: () => calls.push('dismissed'),
    }), true);
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(calls, ['stopped', 'sent']);

    const composing = keyboard('Enter', {
      ctrlKey: true,
      isComposing: true,
      stopPropagation: () => calls.push('ime-stopped'),
    });
    assert.equal(handleComposeModalKeyDown(composing, {
      send: () => calls.push('ime-sent'),
    }), false);
    assert.equal(composing.defaultPrevented, false);
    assert.deepEqual(calls, ['stopped', 'sent']);
  });

  it('activates occupied slots with Cmd/Ctrl+1-9 and leaves empty slots untouched', () => {
    const sessions = [{ id: 'session-2', slot: 2, presentationState: 'minimized' }];
    const occupied = harness({ sessions });
    const occupiedEvent = keyboard('2', { ctrlKey: true });
    occupied.handler(occupiedEvent);
    assert.equal(occupiedEvent.defaultPrevented, true);
    assert.deepEqual(occupied.calls, [['compose.activateSlot2', { source: 'compose-shortcut' }]]);

    const empty = harness({ sessions });
    const emptyEvent = keyboard('3', { metaKey: true });
    assert.equal(empty.handler(emptyEvent), false);
    assert.equal(emptyEvent.defaultPrevented, false);
    assert.deepEqual(empty.calls, []);
  });

  it('leaves a terminal-pending slot chord unhandled until the operation ends', () => {
    const pending = harness({
      sessions: [{ id: 'session-7', slot: 7, terminalPending: 'close' }],
    });
    const pendingEvent = keyboard('7', { ctrlKey: true });
    assert.equal(pending.handler(pendingEvent), false);
    assert.equal(pendingEvent.defaultPrevented, false);
    assert.deepEqual(pending.calls, []);

    const available = harness({
      sessions: [{ id: 'session-7', slot: 7, terminalPending: null }],
    });
    const availableEvent = keyboard('7', { ctrlKey: true });
    assert.equal(available.handler(availableEvent), true);
    assert.equal(availableEvent.defaultPrevented, true);
    assert.deepEqual(available.calls, [[
      'compose.activateSlot7', { source: 'compose-shortcut' },
    ]]);
  });

  it('ignores IME events before resolving every compose chord', () => {
    const sessions = [{ id: 'session-1', slot: 1, presentationState: 'expanded' }];
    for (const event of [
      keyboard('w', { ctrlKey: true, isComposing: true, target: element({ sessionId: 'session-1' }) }),
      keyboard('Escape', { keyCode: 229 }),
      keyboard('1', { metaKey: true, isComposing: true }),
    ]) {
      const { calls, handler } = harness({ sessions, focusedSessionId: 'session-1' });
      assert.equal(handler(event), false);
      assert.equal(event.defaultPrevented, false);
      assert.deepEqual(calls, []);
    }
  });

  it('focuses a fallback slot before the draft-scoped lifecycle command resolves context', async () => {
    const sessions = [{ id: 'session-4', slot: 4, presentationState: 'expanded' }];
    const calls = [];
    let focusedSessionId = null;
    const workspace = {
      focusSession(sessionId) {
        calls.push(['focus', sessionId]);
        focusedSessionId = sessionId;
        return sessions[0];
      },
      minimizeSession(sessionId) {
        calls.push(['minimize', sessionId]);
        return sessions[0];
      },
    };
    const registry = createCommandRegistry(composeSessionCommandDefinitions);
    const getContext = () => context(sessions, focusedSessionId);
    const commandController = createCommandController({
      registry,
      getContext,
      executors: createComposeSessionCommandExecutors({ getController: () => workspace }),
    });
    const handler = createComposeShortcutHandler({
      commandController,
      registry,
      getContext,
      getSessions: () => sessions,
      getVisibleSessions: () => sessions,
      getFocusedSessionId: () => focusedSessionId,
    });
    const event = keyboard('Escape', { shiftKey: true });
    assert.equal(handler(event), true);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(calls, [['focus', 'session-4'], ['minimize', 'session-4']]);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  composeChipInteraction,
  composeChipPresentation,
} from './composePresentationModel.js';

const source = fs.readFileSync(new URL('./ComposeChip.jsx', import.meta.url), 'utf8');

test('renders a lightweight native button with the existing compose icon', () => {
  assert.match(source, /<button/);
  assert.match(source, /type="button"/);
  assert.match(source, /<svg width="14" height="14"/);
  assert.match(source, /M12 20h9/);
  assert.doesNotMatch(source, /@tiptap|CardDAV|ContactPicker|ComposeModal/);
});

test('labels slot, subject fallback, keycap, and persistence state', () => {
  assert.match(source, /session\.subject\?\.trim\(\)/);
  assert.match(source, /common\.noSubject/);
  assert.match(source, /<kbd/);
  assert.match(source, /isMac.*`⌘\$\{session\.slot\}`/s);
  assert.match(source, /`Ctrl\+\$\{session\.slot\}`/);
  assert.match(source, /composeChipPresentation\(session\)/);
  assert.match(source, /aria-label=\{ariaLabel\}/);
  assert.match(source, /textOverflow: 'ellipsis'/);
});

test('restores minimized sessions and focuses overflow sessions', () => {
  assert.match(source, /interaction\.action === 'restore'/);
  assert.match(source, /interaction\.action === 'focus'/);
  assert.match(source, /onRestore\(session\.id\)/);
  assert.match(source, /onFocus\(session\.id\)/);
});

test('makes a terminal-pending chip busy, disabled, and nonfocusable until completion', () => {
  assert.deepEqual(composeChipInteraction({
    id: 'session-7', presentationState: 'minimized', terminalPending: 'close',
  }), {
    disabled: true, tabIndex: -1, ariaBusy: true, action: null,
  });
  assert.deepEqual(composeChipInteraction({
    id: 'session-7', presentationState: 'minimized', terminalPending: null,
  }), {
    disabled: false, tabIndex: 0, ariaBusy: false, action: 'restore',
  });
  assert.deepEqual(composeChipInteraction({
    id: 'session-7', presentationState: 'overflow', terminalPending: null,
  }), {
    disabled: false, tabIndex: 0, ariaBusy: false, action: 'focus',
  });
  assert.match(source, /disabled=\{interaction\.disabled\}/);
  assert.match(source, /tabIndex=\{interaction\.tabIndex\}/);
  assert.match(source, /aria-busy=\{interaction\.ariaBusy\}/);
});

test('classifies every persistence state without calling dirty or error saved', () => {
  const cases = [
    [{ status: 'dirty' }, ['dirty', 'Dirty', false]],
    [{ status: 'saving' }, ['saving', 'Saving', false]],
    [{ status: 'idle' }, ['saved', 'Saved', false]],
    [{ status: 'offline' }, ['offline', 'Offline', true]],
    [{ status: 'error', error: new Error('synthetic') }, ['error', 'Error', true]],
    [{ status: 'conflict', conflict: {} }, ['conflict', 'Conflict', true]],
    [{ status: 'idle', recoveryConflict: {} }, ['conflict', 'Conflict', true]],
    [{ status: 'idle', terminalPending: 'send' }, ['terminalPending', 'Finishing draft', false]],
  ];

  for (const [session, expected] of cases) {
    const state = composeChipPresentation(session);
    assert.deepEqual([state.code, state.defaultLabel, state.warning], expected);
  }
  assert.equal(composeChipPresentation({ status: 'idle', localChanges: { subject: 'x' } }).code, 'dirty');
});

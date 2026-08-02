import test from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_ACTION_TO_COMMAND_ID, normalizeLegacyShortcutOverrides } from './defaultShortcuts.js';

test('normalizes legacy shortcut IDs without mutating persisted preferences', () => {
  const persisted = { toggleRead: 'q', 'mail.toggleRead': 'y', archive: null };
  const normalized = normalizeLegacyShortcutOverrides(persisted);
  assert.equal(LEGACY_ACTION_TO_COMMAND_ID.toggleRead, 'mail.toggleRead');
  assert.deepEqual(normalized, {
    ...persisted,
    'mail.toggleRead': 'y',
    'mail.archive': null,
  });
  assert.deepEqual(persisted, { toggleRead: 'q', 'mail.toggleRead': 'y', archive: null });
});

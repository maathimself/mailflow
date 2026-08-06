import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveCommandKeys, findBindingConflicts, formatCommandKey, getEffectiveCommandBindings } from './shortcuts.js';
import { normalizeLegacyShortcutOverrides } from '../utils/defaultShortcuts.js';

const command = {
  id: 'palette.toggle',
  defaultKeys: {
    primary: { mac: 'meta+k', windows: 'ctrl+k', linux: 'ctrl+k' },
    secondary: ['alt+k'],
  },
};

describe('command shortcut metadata', () => {
  it('selects the platform primary and retains secondary bindings', () => {
    assert.deepEqual(effectiveCommandKeys(command, { platform: 'mac', shortcutOverrides: {} }).bindings, [
      { key: 'meta+k', kind: 'platform' }, { key: 'alt+k', kind: 'secondary' },
    ]);
    assert.equal(effectiveCommandKeys(command, { platform: 'linux', shortcutOverrides: {} }).bindings[0].key, 'ctrl+k');
  });

  it('uses the unchanged user override as primary without deleting secondary keys', () => {
    assert.deepEqual(effectiveCommandKeys(command, {
      platform: 'windows', shortcutOverrides: { 'palette.toggle': 'ctrl+shift+k' },
    }).bindings, [
      { key: 'ctrl+shift+k', kind: 'user' }, { key: 'alt+k', kind: 'secondary' },
    ]);
  });

  it('supports explicit primary unbinding and formats platform labels', () => {
    assert.deepEqual(effectiveCommandKeys(command, {
      platform: 'mac', shortcutOverrides: { 'palette.toggle': null },
    }).bindings, [{ key: 'alt+k', kind: 'secondary' }]);
    assert.equal(formatCommandKey('meta+shift+k', 'mac'), '⌘⇧K');
    assert.equal(formatCommandKey('ctrl+shift+k', 'windows'), 'Ctrl+Shift+K');
  });

  it('reports conflicts instead of silently dropping either command', () => {
    const commands = [command, { ...command, id: 'navigation.search', defaultKeys: { primary: 'alt+k', secondary: [] } }];
    assert.deepEqual(findBindingConflicts(commands, { platform: 'linux', shortcutOverrides: {} }), [
      { key: 'alt+k', commandIds: ['palette.toggle', 'navigation.search'] },
    ]);
  });
});

it('aggregates sequences, platform keys, secondary keys, and legacy overrides', () => {
  const definitions = [
    { ...command, id: 'mail.toggleRead', defaultKeys: { primary: 'u', secondary: ['m'] } },
    { ...command, id: 'navigation.inbox', defaultKeys: { primary: 'g i', secondary: [] } },
  ];
  const context = {
    platform: 'mac',
    shortcutOverrides: normalizeLegacyShortcutOverrides({ toggleRead: 'q' }),
  };
  assert.deepEqual(getEffectiveCommandBindings(definitions, context)[0].bindings, [
    { keys: 'q', source: 'user' },
    { keys: 'm', source: 'secondary' },
  ]);
  assert.equal(formatCommandKey('g i', 'linux'), 'G then I');
});

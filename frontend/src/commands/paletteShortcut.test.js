import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { commandPaletteShortcut } from './paletteShortcut.js';

describe('commandPaletteShortcut', () => {
  it('ignores unrelated and mobile events', () => {
    assert.equal(commandPaletteShortcut({ key: 'x', metaKey: true }, null, 1).handled, false);
    assert.equal(commandPaletteShortcut({ key: 'k', metaKey: true, isMobile: true }, null, 1).handled, false);
  });

  it('ignores Cmd/Ctrl+K while an IME is composing', () => {
    assert.equal(commandPaletteShortcut({ key: 'k', metaKey: true, isComposing: true }, null, 1).handled, false);
    assert.equal(commandPaletteShortcut({ key: 'k', ctrlKey: true, keyCode: 229 }, null, 1).handled, false);
  });

  it('toggles ordinary Cmd/Ctrl+K immediately', () => {
    assert.deepEqual(commandPaletteShortcut({ key: 'k', metaKey: true, target: {} }, null, 1), {
      handled: true, toggle: true, nextEditorPress: null,
    });
  });

  it('preserves first rich-editor Insert Link and opens on the next press', () => {
    const editor = { isContentEditable: true };
    const first = commandPaletteShortcut({ key: 'k', ctrlKey: true, target: editor }, null, 1000);
    assert.equal(first.toggle, false);
    const second = commandPaletteShortcut({ key: 'k', ctrlKey: true, target: editor }, first.nextEditorPress, 2000);
    assert.equal(second.toggle, true);
    assert.equal(second.nextEditorPress, null);
  });

  it('expires the editor second-press window after 1500 ms', () => {
    const editor = { isContentEditable: true };
    const old = { target: editor, at: 1000 };
    assert.equal(commandPaletteShortcut({ key: 'k', metaKey: true, target: editor }, old, 2501).toggle, false);
  });
});

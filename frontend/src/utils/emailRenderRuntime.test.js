import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEmailFrameContextMenuHandler } from './emailRenderRuntime.js';

describe('createEmailFrameContextMenuHandler', () => {
  it('uses the latest pane actions without reinstalling the document handler', () => {
    const opened = [];
    let actions = {
      hasNativeContextTarget: () => false,
      openPaneContextMenu: () => opened.push('stale'),
    };
    const document = { getSelection: () => ({ toString: () => 'selected text' }) };
    const iframe = { getBoundingClientRect: () => ({ left: 10, top: 20 }) };
    const handler = createEmailFrameContextMenuHandler({
      document,
      iframe,
      getActions: () => actions,
    });

    actions = {
      hasNativeContextTarget: () => false,
      openPaneContextMenu: (x, y, options) => opened.push({ x, y, options }),
    };
    let prevented = false;
    handler({ clientX: 4, clientY: 6, preventDefault: () => { prevented = true; } });

    assert.equal(prevented, true);
    assert.deepEqual(opened, [{
      x: 14,
      y: 26,
      options: { source: 'iframe', selectedText: 'selected text' },
    }]);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEmailIframeGeometry,
  createEmailFrameContextMenuHandler,
} from './emailRenderRuntime.js';

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

describe('applyEmailIframeGeometry', () => {
  it('clears a stale wrapper scale before measuring a narrower reflow', () => {
    const style = () => ({
      setProperty(name, value) { this[name] = value; },
      removeProperty(name) { delete this[name]; },
    });
    const wrapper = {
      style: { width: '1000px', transform: 'scale(0.5)', transformOrigin: 'top left' },
    };
    const root = { style: style(), scrollHeight: 200, get scrollWidth() { return wrapper.style.width ? 1000 : 400; } };
    const body = { style: style(), scrollHeight: 200, get scrollWidth() { return wrapper.style.width ? 1000 : 400; } };
    const document = {
      body,
      documentElement: root,
      getElementById: id => id === 'mf-scale-wrapper' ? wrapper : null,
    };

    const geometry = applyEmailIframeGeometry({
      document,
      iframe: { offsetWidth: 500, clientWidth: 500 },
    });

    assert.equal(geometry.naturalWidth, 400);
    assert.equal(geometry.scale, 1);
    assert.deepEqual(wrapper.style, { width: '', transform: '', transformOrigin: '' });
  });
});

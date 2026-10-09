// Run with: node --test src/utils/iframeKeys.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { forwardIframeKeydown } from './iframeKeys.js';

// Two documents, as in the app: the email frame's and the page's.
function setup() {
  const page = new JSDOM('<!doctype html><body></body>').window;
  const frame = new JSDOM('<!doctype html><body><p id="text">Hello</p><input id="field"><div id="edit" contenteditable="true"></div></body>').window;
  const seen = [];
  page.document.addEventListener('keydown', e => {
    seen.push({ key: e.key, code: e.code, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey, target: e.target });
    if (e.key === '#') e.preventDefault(); // a bound shortcut the page handles
  });
  const press = (target, init) => {
    const ev = new frame.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(ev);
    return { ev, forwarded: forwardIframeKeydown(ev, page.document) };
  };
  return { page, frame, seen, press };
}

describe('forwardIframeKeydown (#537)', () => {
  it('re-sends a key pressed in the frame to the page, with its key, code and modifiers', () => {
    const { frame, page, seen, press } = setup();
    const { forwarded } = press(frame.document.getElementById('text'), { key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true });
    assert.equal(forwarded, true);
    assert.equal(seen.length, 1);
    assert.deepEqual({ ...seen[0], target: undefined }, { key: 'Z', code: 'KeyZ', ctrl: true, meta: false, alt: false, shift: true, target: undefined });
    assert.equal(seen[0].target, page.document); // not an element, so handlers see "not typing"
  });

  it('cancels the original when a page handler cancelled the copy, and only then', () => {
    const { frame, press } = setup();
    assert.equal(press(frame.document.body, { key: '#' }).ev.defaultPrevented, true);
    assert.equal(press(frame.document.body, { key: 'q' }).ev.defaultPrevented, false);
  });

  it('leaves typing in a field or an editable area inside the frame alone', () => {
    const { frame, seen, press } = setup();
    assert.equal(press(frame.document.getElementById('field'), { key: '#' }).forwarded, false);
    const edit = frame.document.getElementById('edit');
    Object.defineProperty(edit, 'isContentEditable', { value: true }); // jsdom does not compute it
    assert.equal(press(edit, { key: '#' }).forwarded, false);
    assert.equal(seen.length, 0);
  });

  it('skips IME composition and presses the frame already handled', () => {
    const { frame, seen, press } = setup();
    assert.equal(press(frame.document.body, { key: 'a', isComposing: true }).forwarded, false);
    const ev = new frame.KeyboardEvent('keydown', { key: 'a', cancelable: true });
    ev.preventDefault();
    assert.equal(forwardIframeKeydown(ev, setup().page.document), false);
    assert.equal(seen.length, 0);
  });
});

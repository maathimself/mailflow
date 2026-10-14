// Giving focus back to the page after a click on an email, where the frame cannot pass keys on
// (WebKit). The browser part (that WebKit really keeps focus in the frame and blocks its
// listeners) is checked in WebKit itself; this is the decision logic.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { returnFocusFromFrame, RETURN_AFTER_MS, RECHECK_MS } from './frameFocus.js';

const wait = (ms) => new Promise(r => setTimeout(r, ms));

describe('returnFocusFromFrame', () => {
  let dom, doc, iframe, list, selection, stop;
  beforeEach(() => {
    dom = new JSDOM('<div id="list" tabindex="0">list</div><iframe id="f"></iframe>', { pretendToBeVisual: true });
    doc = dom.window.document;
    list = doc.getElementById('list');
    iframe = doc.getElementById('f');
    selection = '';
    // The email's selection, as the frame's document reports it.
    Object.defineProperty(iframe, 'contentDocument', {
      value: { getSelection: () => ({ isCollapsed: !selection, toString: () => selection }) },
    });
    list.focus();
    stop = returnFocusFromFrame(iframe);
  });
  afterEach(() => stop());

  // A click on the email: focus moves into the frame and the page's window loses focus.
  const clickEmail = () => {
    iframe.focus();
    dom.window.dispatchEvent(new dom.window.Event('blur'));
  };

  test('after a click on the email, focus goes back to what had it', async () => {
    clickEmail();
    assert.equal(doc.activeElement, iframe);
    await wait(RETURN_AFTER_MS + 50);
    assert.equal(doc.activeElement, list);
  });

  test('a selection in the email keeps focus there, for Copy, until it is cleared', async () => {
    clickEmail();
    selection = 'some words';
    await wait(RETURN_AFTER_MS + RECHECK_MS * 2);
    assert.equal(doc.activeElement, iframe, 'kept while text is selected');
    selection = '';
    await wait(RECHECK_MS + 50);
    assert.equal(doc.activeElement, list, 'given back once the selection is gone');
  });

  test('focus that arrived by Tab (the email\'s links, by keyboard) is left alone', async () => {
    doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    clickEmail();
    await wait(RETURN_AFTER_MS + 50);
    assert.equal(doc.activeElement, iframe);
  });

  test('with what had focus gone, focus goes to an invisible spot in the page', async () => {
    list.remove();
    clickEmail();
    await wait(RETURN_AFTER_MS + 50);
    assert.equal(doc.activeElement?.id, 'mf-focus-sink');
    assert.equal(doc.activeElement.tabIndex, -1, 'not in the tab order');
  });

  test('after typing in a text field, focus goes to the list, not back into the field', async () => {
    const search = doc.createElement('input');
    doc.body.appendChild(search);
    search.focus();
    clickEmail();
    await wait(RETURN_AFTER_MS + 50);
    assert.equal(doc.activeElement, list, 'the shortcuts would type into the field');
    search.remove();
  });

  test('focus that moves from one email straight into another still comes back', async () => {
    // A second email, as in a conversation with two cards open. The page's window blurs only
    // once, for the first: moving between frames is not a new blur.
    const second = doc.createElement('iframe');
    doc.body.appendChild(second);
    Object.defineProperty(second, 'contentDocument', { value: { getSelection: () => ({ isCollapsed: true, toString: () => '' }) } });
    const stopSecond = returnFocusFromFrame(second);
    try {
      clickEmail();
      selection = 'kept for Copy';
      await wait(RETURN_AFTER_MS + 50);
      assert.equal(doc.activeElement, iframe, 'held while text is selected in the first');
      second.focus(); // a click on the second email: no blur this time
      await wait(RECHECK_MS + RETURN_AFTER_MS + 100);
      assert.equal(doc.activeElement, list);
    } finally {
      stopSecond();
      second.remove();
    }
  });

  test('stops when cleaned up', async () => {
    stop();
    clickEmail();
    await wait(RETURN_AFTER_MS + 50);
    assert.equal(doc.activeElement, iframe);
  });
});

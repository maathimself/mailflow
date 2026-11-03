// Giving focus back to the page after a click on an email, where the frame cannot pass keys on
// (WebKit). The browser part (that WebKit really keeps focus in the frame and blocks its
// listeners) is checked in WebKit itself; this is the decision logic.
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { returnFocusFromFrame, RETURN_AFTER_MS, RECHECK_MS } from './frameFocus.js';

describe('returnFocusFromFrame', () => {
  let dom, doc, iframe, list, selection, stop;
  beforeEach(() => {
    dom = new JSDOM('<div id="list" tabindex="0">list</div><iframe id="f"></iframe>', { pretendToBeVisual: true });
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
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
  afterEach(() => {
    try {
      stop();
      dom.window.close();
    } finally {
      mock.timers.reset();
    }
  });

  // A click on the email: focus moves into the frame and the page's window loses focus.
  const clickEmail = () => {
    iframe.focus();
    dom.window.dispatchEvent(new dom.window.Event('blur'));
  };

  test('after a click on the email, focus goes back to what had it', () => {
    clickEmail();
    assert.equal(doc.activeElement, iframe);
    mock.timers.tick(0); // inspect the blur before starting the return interval
    mock.timers.tick(RETURN_AFTER_MS - 1);
    assert.equal(doc.activeElement, iframe, 'kept during the click grace');
    mock.timers.tick(1);
    assert.equal(doc.activeElement, list);
  });

  test('a selection in the email keeps focus there, for Copy, until it is cleared', () => {
    clickEmail();
    selection = 'some words';
    mock.timers.tick(0);
    mock.timers.tick(RETURN_AFTER_MS);
    assert.equal(doc.activeElement, iframe, 'kept at the return deadline');
    mock.timers.tick(RECHECK_MS);
    assert.equal(doc.activeElement, iframe, 'kept through a selection recheck');
    mock.timers.tick(RECHECK_MS);
    assert.equal(doc.activeElement, iframe, 'kept while text is selected');
    selection = '';
    mock.timers.tick(RECHECK_MS - 1);
    assert.equal(doc.activeElement, iframe, 'kept until the next recheck');
    mock.timers.tick(1);
    assert.equal(doc.activeElement, list, 'given back once the selection is gone');
  });

  test('focus that arrived by Tab (the email\'s links, by keyboard) is left alone', () => {
    doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    clickEmail();
    mock.timers.tick(0);
    mock.timers.tick(RETURN_AFTER_MS + RECHECK_MS);
    assert.equal(doc.activeElement, iframe);
  });

  test('with what had focus gone, focus goes to an invisible spot in the page', () => {
    list.remove();
    clickEmail();
    mock.timers.tick(0);
    mock.timers.tick(RETURN_AFTER_MS - 1);
    assert.equal(doc.activeElement, iframe, 'kept during the click grace');
    mock.timers.tick(1);
    assert.equal(doc.activeElement?.id, 'mf-focus-sink');
    assert.equal(doc.activeElement.tabIndex, -1, 'not in the tab order');
  });

  test('after typing in a text field, focus goes to the list, not back into the field', () => {
    const search = doc.createElement('input');
    doc.body.appendChild(search);
    search.focus();
    clickEmail();
    mock.timers.tick(0);
    mock.timers.tick(RETURN_AFTER_MS - 1);
    assert.equal(doc.activeElement, iframe, 'kept during the click grace');
    mock.timers.tick(1);
    assert.equal(doc.activeElement, list, 'the shortcuts would type into the field');
    search.remove();
  });

  test('focus that moves from one email straight into another still comes back', () => {
    // A second email, as in a conversation with two cards open. The page's window blurs only
    // once, for the first: moving between frames is not a new blur.
    const second = doc.createElement('iframe');
    doc.body.appendChild(second);
    Object.defineProperty(second, 'contentDocument', { value: { getSelection: () => ({ isCollapsed: true, toString: () => '' }) } });
    const stopSecond = returnFocusFromFrame(second);
    try {
      clickEmail();
      selection = 'kept for Copy';
      mock.timers.tick(0);
      mock.timers.tick(RETURN_AFTER_MS);
      assert.equal(doc.activeElement, iframe, 'held while text is selected in the first');
      second.focus(); // a click on the second email: no blur this time
      mock.timers.tick(RECHECK_MS);
      mock.timers.tick(RETURN_AFTER_MS - 1);
      assert.equal(doc.activeElement, second, 'kept during the second frame grace');
      mock.timers.tick(1);
      assert.equal(doc.activeElement, list);
    } finally {
      stopSecond();
      second.remove();
    }
  });

  test('stops when cleaned up', () => {
    stop();
    clickEmail();
    mock.timers.tick(0);
    mock.timers.tick(RETURN_AFTER_MS + RECHECK_MS);
    assert.equal(doc.activeElement, iframe);
  });
});

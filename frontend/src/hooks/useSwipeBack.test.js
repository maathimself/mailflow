// The back swipe's rules (#229). How it feels on a real email is checked in a browser.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { swipeAxis, startsBackSwipe, DECIDE, EDGE } from './useSwipeBack.js';

describe('swipeAxis', () => {
  test('undecided until the finger has moved', () => {
    assert.equal(swipeAxis(DECIDE - 1, 3), null);
  });
  test('across only when clearly more across than down', () => {
    assert.equal(swipeAxis(30, 5), 'h');
    assert.equal(swipeAxis(30, 20), 'v', 'a diagonal is a scroll');
    assert.equal(swipeAxis(3, 40), 'v');
  });
});

describe('startsBackSwipe', () => {
  const { document } = new JSDOM(`<div id="pane"><div id="bar"><button id="back">Back</button></div>
    <div data-swipe-pager><p id="body">text</p><input id="field"></div><div data-swipe-edge id="edge"></div></div>`).window;
  const $ = (id) => document.getElementById(id);
  test('from the edge strip, wherever it is', () => {
    assert.equal(startsBackSwipe($('edge'), 4), true);
  });
  test('from the first EDGE px outside the pager (the top bar)', () => {
    assert.equal(startsBackSwipe($('bar'), EDGE), true);
    assert.equal(startsBackSwipe($('bar'), EDGE + 1), false);
  });
  test('never from inside the pager, where swiping turns pages', () => {
    assert.equal(startsBackSwipe($('body'), 2), false);
  });
  test('never from a field', () => {
    assert.equal(startsBackSwipe($('field'), 2), false);
  });
});

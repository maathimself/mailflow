import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { fitScale, fitEmailToFrame, contentOverflows, createFitGuard, GROW_SLACK_PX } from './emailFrameFit.js';

describe('fitScale', () => {
  test('leaves an email that fits at 1', () => {
    assert.equal(fitScale({ frameW: 800, contentW: 600 }), 1);
    assert.equal(fitScale({ frameW: 800, contentW: 802 }), 1, 'within rounding');
  });

  test('scales a wide email down to the frame', () => {
    assert.equal(fitScale({ frameW: 600, contentW: 900 }), 600 / 900);
  });

  test('shrinks again when the email grows wider after it was fitted', () => {
    const first = fitScale({ frameW: 600, contentW: 650 });
    assert.equal(fitScale({ frameW: 600, contentW: 900, scale: first }), 600 / 900);
  });

  test('shrinks again when the frame gets narrower', () => {
    assert.equal(fitScale({ frameW: 450, contentW: 900, scale: 600 / 900 }), 450 / 900);
    assert.equal(fitScale({ frameW: 700, contentW: 750, scale: 1 }), 700 / 750);
  });

  test('grows back, to 1 at most, when the frame gets wider', () => {
    assert.equal(fitScale({ frameW: 800, contentW: 900, scale: 0.5 }), 800 / 900);
    assert.equal(fitScale({ frameW: 1200, contentW: 900, scale: 0.5 }), 1);
  });

  test('with a slack, holds a smaller scale when growing gains no more than it', () => {
    // 600 shown in 615: the width a pane scrollbar takes and gives back.
    const scale = 600 / 900;
    const growSlack = GROW_SLACK_PX;
    assert.equal(fitScale({ frameW: 615, contentW: 900, scale }), 615 / 900, 'no slack: grows');
    assert.equal(fitScale({ frameW: 600 + growSlack, contentW: 900, scale, growSlack }), scale);
    assert.equal(fitScale({ frameW: 600 + growSlack + 1, contentW: 900, scale, growSlack }), (600 + growSlack + 1) / 900);
    assert.equal(fitScale({ frameW: 590, contentW: 900, scale, growSlack }), 590 / 900, 'shrinking ignores it');
  });

  test('never grows when told not to, but still shrinks', () => {
    assert.equal(fitScale({ frameW: 1200, contentW: 900, scale: 0.5, allowGrow: false }), 0.5);
    assert.equal(fitScale({ frameW: 300, contentW: 900, scale: 0.5, allowGrow: false }), 300 / 900);
  });

  test('keeps the current scale when a width is unknown', () => {
    assert.equal(fitScale({ frameW: 0, contentW: 900, scale: 0.5 }), 0.5);
    assert.equal(fitScale({ frameW: 600, contentW: 0, scale: 0.5 }), 0.5);
    assert.equal(fitScale({ frameW: NaN, contentW: 900 }), 1);
    assert.equal(fitScale({ frameW: 600, contentW: 900, scale: NaN }), 600 / 900);
  });
});

// jsdom does no layout, so the content's width is whatever the test says it is.
function frameDoc() {
  const { document } = new JSDOM('<body><div id="mf-scale-wrapper"><table></table></div></body>').window;
  const sizes = { content: 0, wrapperClient: 0 };
  Object.defineProperty(document.body, 'scrollWidth', { get: () => sizes.content });
  Object.defineProperty(document.documentElement, 'scrollWidth', { get: () => sizes.content });
  const wrapper = document.getElementById('mf-scale-wrapper');
  Object.defineProperty(wrapper, 'scrollWidth', { get: () => sizes.content });
  Object.defineProperty(wrapper, 'clientWidth', { get: () => sizes.wrapperClient });
  return { document, wrapper, sizes };
}

describe('fitEmailToFrame', () => {
  test('scales a wide email and locks the wrapper at its width', () => {
    const { document, wrapper, sizes } = frameDoc();
    sizes.content = 900;
    assert.equal(fitEmailToFrame(document, 600), 600 / 900);
    assert.equal(wrapper.style.transform, `scale(${600 / 900})`);
    assert.equal(wrapper.style.transformOrigin, 'top left');
    assert.equal(wrapper.style.width, '900px');
    assert.equal(document.body.style.overflowX, '', 'the iOS measuring override is removed again');
  });

  test('runs again on the same document: a wider email, then a wider frame', () => {
    const { document, wrapper, sizes } = frameDoc();
    sizes.content = 600;
    let scale = fitEmailToFrame(document, 600);
    assert.equal(scale, 1);
    assert.equal(wrapper.getAttribute('style'), null, 'an email that fits is left alone');

    sizes.content = 900; // its hero image arrived
    scale = fitEmailToFrame(document, 600, { scale });
    assert.equal(scale, 600 / 900);
    assert.equal(wrapper.style.width, '900px');

    scale = fitEmailToFrame(document, 450, { scale }); // the sidebar opened
    assert.equal(scale, 0.5);
    assert.equal(wrapper.style.transform, 'scale(0.5)');

    scale = fitEmailToFrame(document, 1000, { scale }); // and closed, with room to spare
    assert.equal(scale, 1);
    assert.equal(wrapper.style.transform, '');
    assert.equal(wrapper.style.width, '');
  });

  test('a document without the wrapper is shown as is', () => {
    const { document } = new JSDOM('<body><p>x</p></body>').window;
    assert.equal(fitEmailToFrame(document, 600), 1);
  });
});

describe('contentOverflows', () => {
  test('only when the email is wider than the box it is laid out in', () => {
    const { document, sizes } = frameDoc();
    sizes.wrapperClient = 600;
    sizes.content = 600;
    assert.equal(contentOverflows(document), false);
    sizes.content = 602;
    assert.equal(contentOverflows(document), false, 'within rounding');
    sizes.content = 900;
    assert.equal(contentOverflows(document), true);
  });
});

describe('createFitGuard', () => {
  test('asks for the slack only right after a shrink', () => {
    const g = createFitGuard();
    assert.deepEqual(g.limits(600), { allowGrow: true, growSlack: 0 });
    g.record(1, 0.8, 600, 0);
    assert.deepEqual(g.limits(600), { allowGrow: true, growSlack: GROW_SLACK_PX });
    g.record(0.8, 0.82, 620, 16); // a sidebar's transition, one step in
    assert.deepEqual(g.limits(640), { allowGrow: true, growSlack: 0 });
  });

  test('allows growing while scales change in one direction or now and then', () => {
    const g = createFitGuard();
    let t = 0;
    for (const [a, b] of [[1, 0.8], [0.8, 0.6], [0.6, 1], [1, 0.7], [0.7, 1]]) {
      g.record(a, b, 600, t += 1500);
    }
    assert.equal(g.limits(600).allowGrow, true);
  });

  test('stops growing when the scale flips back and forth, until the frame really resizes', () => {
    const g = createFitGuard();
    let t = 0;
    for (let i = 0; i < 6; i++) g.record(i % 2 ? 0.9 : 0.95, i % 2 ? 0.95 : 0.9, 600, t += 16);
    assert.equal(g.limits(615).allowGrow, false, 'a scrollbar width away is still the same layout');
    assert.equal(g.limits(800).allowGrow, true, 'a real resize starts afresh');
  });
});

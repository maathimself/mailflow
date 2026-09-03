import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { measureContentHeight, createHeightController, forceEagerImages } from './emailFrameHeight.js';

describe('measureContentHeight', () => {
  test('uses the wrapper box, offset by where the wrapper starts', () => {
    assert.equal(measureContentHeight({ wrapperOffsetHeight: 1500, wrapperOffsetTop: 8 }), 1508);
  });

  test('falls back to the body when content escapes the wrapper box', () => {
    // A floated or absolutely positioned element can overflow #mf-scale-wrapper.
    assert.equal(measureContentHeight({ wrapperOffsetHeight: 1200, bodyScrollHeight: 1900 }), 1900);
  });

  test('ignores nonsense values instead of propagating NaN', () => {
    assert.equal(measureContentHeight({ wrapperOffsetHeight: NaN, bodyScrollHeight: 900 }), 900);
    assert.equal(measureContentHeight({ wrapperOffsetHeight: -50, bodyScrollHeight: 900 }), 900);
    assert.equal(measureContentHeight({}), 0);
    assert.equal(measureContentHeight(), 0);
  });

  test('has no viewport floor: a short email measures short no matter how tall the frame is', () => {
    // This is the regression that produced the whitespace. documentElement.scrollHeight
    // would have returned the frame height here; these inputs must not.
    assert.equal(measureContentHeight({ wrapperOffsetHeight: 600, bodyScrollHeight: 600 }), 600);
  });
});

describe('createHeightController', () => {
  test('applies the first measurement', () => {
    const c = createHeightController();
    assert.equal(c.next(1500), 1500);
    assert.equal(c.height, 1500);
  });

  test('grows as lazy images load', () => {
    const c = createHeightController();
    assert.equal(c.next(800), 800);
    assert.equal(c.next(2000), 2000);
    assert.equal(c.next(3400), 3400);
  });

  test('SHRINKS, which the old grow-only ratchet could not do', () => {
    // The whitespace bug in one line: an over-measurement must be correctable.
    const c = createHeightController();
    assert.equal(c.next(4000), 4000); // measured against a stale/taller document
    assert.equal(c.next(1500), 1500); // real content is shorter, so come back down
    assert.equal(c.height, 1500);
  });

  test('ignores sub-pixel churn so a ResizeObserver cannot ping-pong', () => {
    const c = createHeightController({ tolerancePx: 1 });
    assert.equal(c.next(1500), 1500);
    assert.equal(c.next(1500.4), null);
    assert.equal(c.next(1501), null);
    assert.equal(c.next(1503), 1503);
  });

  test('applies the scale factor for wide fixed-layout emails', () => {
    const c = createHeightController();
    assert.equal(c.next(2000, 0.5), 1000);
  });

  test('treats a missing or absurd scale as 1 rather than collapsing the frame', () => {
    const c = createHeightController();
    assert.equal(c.next(1000, 0), 1000);
    assert.equal(c.next(1200, NaN), 1200);
    assert.equal(c.next(1400, undefined), 1400);
  });

  test('rejects unusable measurements without disturbing the applied height', () => {
    const c = createHeightController();
    assert.equal(c.next(1500), 1500);
    assert.equal(c.next(NaN), null);
    assert.equal(c.next(-1), null);
    assert.equal(c.height, 1500);
  });

  test('freezes at the TALLEST height when the layout oscillates, so nothing is clipped', () => {
    const c = createHeightController();
    assert.equal(c.next(1000), 1000);
    assert.equal(c.next(1200), 1200);
    // Back to a height already seen: the layout is flapping.
    assert.equal(c.next(1000), null, 'already applied 1200, so no DOM write is needed');
    assert.equal(c.frozen, true);
    assert.equal(c.height, 1200, 'must settle tall, never clip the email');
    assert.equal(c.next(9999), null, 'frozen controller ignores everything after');
  });

  test('on oscillation, grows back to the tallest when currently sitting shorter', () => {
    const c = createHeightController();
    assert.equal(c.next(1200), 1200);
    assert.equal(c.next(1000), 1000);
    assert.equal(c.next(1200), 1200, 'must re-apply the tall height, not leave content clipped');
    assert.equal(c.frozen, true);
    assert.equal(c.height, 1200);
  });

  test('stops after maxCommits as an absolute loop backstop', () => {
    const c = createHeightController({ maxCommits: 3 });
    assert.equal(c.next(100), 100);
    assert.equal(c.next(200), 200);
    assert.equal(c.next(300), 300);
    assert.equal(c.frozen, true);
    assert.equal(c.next(400), null);
  });

  test('reset clears state for the next email, including a freeze', () => {
    const c = createHeightController({ maxCommits: 1 });
    assert.equal(c.next(4000), 4000);
    assert.equal(c.frozen, true);
    c.reset();
    assert.equal(c.frozen, false);
    assert.equal(c.height, null);
    // Crucially the new email is free to be shorter than the frame currently is.
    assert.equal(c.next(900), 900);
  });

  test('end to end: stale tall document, then the real short email', () => {
    // Reproduces the reported sequence. onLoaded runs against a document that is
    // not the new email (stale or about:blank), then again on the real load.
    const c = createHeightController();
    assert.equal(c.next(measureContentHeight({ wrapperOffsetHeight: 4200 })), 4200);
    c.reset(); // real document arrives
    const real = c.next(measureContentHeight({ wrapperOffsetHeight: 1470, bodyScrollHeight: 1470 }));
    assert.equal(real, 1470, 'no leftover whitespace from the previous measurement');
  });
});

// ── forceEagerImages ────────────────────────────────────────────────────────────────────

describe('forceEagerImages', () => {
  // jsdom rather than a hand-rolled stub so the selector and the loading property behave
  // the way they do in a browser, including the reflection between attribute and property.
  const docFrom = async (html) => {
    const { JSDOM } = await import('jsdom');
    return new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;
  };

  test('flips lazy images to eager', async () => {
    const doc = await docFrom('<img src="a.png" loading="lazy"><img src="b.png" loading="lazy">');
    assert.equal(forceEagerImages(doc), 2);
    const loading = [...doc.querySelectorAll('img')].map(i => i.getAttribute('loading'));
    assert.deepEqual(loading, ['eager', 'eager']);
  });

  test('leaves images that were never lazy alone', async () => {
    const doc = await docFrom('<img src="a.png"><img src="b.png" loading="eager">');
    assert.equal(forceEagerImages(doc), 0);
    assert.equal(doc.querySelectorAll('img')[0].getAttribute('loading'), null,
      'an image with no loading attribute must not gain one');
    assert.equal(doc.querySelectorAll('img')[1].getAttribute('loading'), 'eager');
  });

  test('matches the attribute case-insensitively, as HTML does', async () => {
    const doc = await docFrom('<img src="a.png" loading="LAZY">');
    assert.equal(forceEagerImages(doc), 1);
    assert.equal(doc.querySelector('img').getAttribute('loading'), 'eager');
  });

  test('handles a document with no images', async () => {
    const doc = await docFrom('<p>no pictures here</p>');
    assert.equal(forceEagerImages(doc), 0);
  });

  test('is safe on a missing or unusable document', () => {
    // onLoaded can in principle run against a frame whose document has gone away.
    assert.equal(forceEagerImages(null), 0);
    assert.equal(forceEagerImages(undefined), 0);
    assert.equal(forceEagerImages({}), 0);
  });
});

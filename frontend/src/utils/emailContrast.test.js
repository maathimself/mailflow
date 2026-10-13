// Contrast of rendered email text (#228): the color math. What counts as visible text is checked in
// a real browser by the dark-mode audit harness's self-test (scripts/dark-audit), as it needs layout.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseColor, composite, contrastRatio, summarize, paintsImage } from './emailContrast.js';

describe('parseColor', () => {
  test('reads computed rgb() and rgba(), in both syntaxes', () => {
    assert.deepEqual(parseColor('rgb(255, 0, 10)'), { r: 255, g: 0, b: 10, a: 1 });
    assert.deepEqual(parseColor('rgba(0, 0, 0, 0.5)'), { r: 0, g: 0, b: 0, a: 0.5 });
    assert.deepEqual(parseColor('rgb(1 2 3 / 25%)'), { r: 1, g: 2, b: 3, a: 0.25 });
    assert.deepEqual(parseColor('transparent'), { r: 0, g: 0, b: 0, a: 0 });
  });
  test('reports what it cannot read as unknown', () => {
    assert.equal(parseColor('oklch(0.7 0.1 200)'), null);
    assert.equal(parseColor('color(srgb 1 0 0)'), null);
    assert.equal(parseColor(undefined), null);
  });
});

describe('contrastRatio', () => {
  test('matches the WCAG reference values', () => {
    const black = { r: 0, g: 0, b: 0 };
    const white = { r: 255, g: 255, b: 255 };
    assert.equal(Math.round(contrastRatio(black, white) * 100) / 100, 21);
    assert.equal(contrastRatio(white, white), 1);
    // #777 on white is the classic just-below-AA gray.
    assert.equal(Math.round(contrastRatio({ r: 119, g: 119, b: 119 }, white) * 100) / 100, 4.48);
  });
  test('is symmetric', () => {
    const a = { r: 10, g: 200, b: 30 };
    const b = { r: 240, g: 240, b: 250 };
    assert.equal(contrastRatio(a, b), contrastRatio(b, a));
  });
});

describe('composite', () => {
  test('paints a translucent color over an opaque one', () => {
    assert.deepEqual(composite({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 }), { r: 127.5, g: 127.5, b: 127.5, a: 1 });
    assert.deepEqual(composite({ r: 9, g: 9, b: 9, a: 1 }, { r: 255, g: 255, b: 255, a: 1 }), { r: 9, g: 9, b: 9, a: 1 });
  });
});

describe('summarize', () => {
  test('counts characters, keeping text over images, unknown colors and hidden text apart', () => {
    const s = summarize([
      { i: 0, chars: 10, ratio: 12, large: false, overImage: false },
      { i: 1, chars: 5, ratio: 2.5, large: false, overImage: false },
      { i: 2, chars: 4, ratio: 3.5, large: false, overImage: false },
      { i: 3, chars: 4, ratio: 3.5, large: true, overImage: false },
      { i: 4, chars: 7, ratio: 1.2, large: false, overImage: true },
      { i: 5, chars: 3, ratio: null, large: false, overImage: false },
      { i: 6, chars: 8, ratio: 1, large: false, overImage: false },
    ]);
    assert.deepEqual(s, { chars: 41, overImage: 7, unknown: 3, hidden: 8, unreadable: 5, weak: 9, worst: 2.5 });
  });
});

describe('paintsImage', () => {
  test('an image or gradient paints; none, and images MailFlow blocked, do not', () => {
    assert.equal(paintsImage('url("https://example.invalid/a.png")'), true);
    assert.equal(paintsImage('linear-gradient(rgb(0, 0, 0), rgb(255, 255, 255))'), true);
    assert.equal(paintsImage('none'), false);
    assert.equal(paintsImage(''), false);
    assert.equal(paintsImage('url("data:,")'), false, 'blocked, as a computed style reports it');
    assert.equal(paintsImage('url(data:,)'), false, 'blocked, as the HTML writes it');
    assert.equal(paintsImage('url("data:,"), url("data:,")'), false);
    assert.equal(paintsImage('url("data:,"), url("https://example.invalid/b.png")'), true);
  });
});

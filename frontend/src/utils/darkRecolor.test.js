// Recoloring an email for a dark theme (#228): the color decisions. The pass over a rendered email
// needs layout and is checked in Chromium by the dark-mode audit harness's self-test.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { themeAnchors, darkBackground, darkText, darkBorder, lightenTo, PIVOT, MIN_TEXT, MAX_TEXT } from './darkRecolor.js';
import { contrastRatio } from './emailContrast.js';
import { rgbToOklch } from './oklch.js';

const anchors = themeAnchors({ background: '#0f0f11', text: '#e8e8f0' });
const rgb = (hex) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
};
const L = (c) => rgbToOklch(c).L;
const hueGap = (a, b) => { const d = Math.abs(rgbToOklch(a).h - rgbToOklch(b).h) % 360; return Math.min(d, 360 - d); };
const near = (a, b, tolerance = 2) => ['r', 'g', 'b'].every(k => Math.abs(a[k] - b[k]) <= tolerance);

describe('darkBackground', () => {
  test("white becomes the theme's background", () => {
    assert.ok(near(darkBackground(rgb('#ffffff'), anchors), rgb('#0f0f11')), JSON.stringify(darkBackground(rgb('#ffffff'), anchors)));
  });
  test('a pale gray becomes a shade lighter than the background, keeping the order of lightness reversed', () => {
    const page = darkBackground(rgb('#f4f4f4'), anchors);
    const card = darkBackground(rgb('#ffffff'), anchors);
    assert.ok(L(page) > L(card));
    assert.ok(L(page) < 0.25);
  });
  test('dark colors are left as they are', () => {
    for (const hex of ['#000000', '#1a237e', '#333333', '#7a1f1f']) {
      const c = rgb(hex);
      assert.ok(L(c) <= PIVOT, hex);
      assert.equal(darkBackground(c, anchors), c, hex);
    }
  });
  test('a light colored background turns dark and keeps its hue', () => {
    for (const hex of ['#e3f2fd', '#fff3cd', '#ffe0e6', '#d4edda', '#ffd54f']) {
      const out = darkBackground(rgb(hex), anchors);
      assert.ok(L(out) <= PIVOT, `${hex} dark`);
      assert.ok(hueGap(out, rgb(hex)) < 12, `${hex} hue kept`);
    }
  });
  test('the mapping is continuous at the pivot and never makes a color lighter', () => {
    for (let l = 0.3; l <= 1; l += 0.01) {
      const gray = Math.round(255 * l);
      const c = { r: gray, g: gray, b: gray, a: 1 };
      assert.ok(L(darkBackground(c, anchors)) <= L(c) + 1e-3, String(gray));
    }
  });
});

describe('darkText', () => {
  const white = rgb('#ffffff');
  const darkBg = rgb('#0f0f11');
  test("black body text becomes light, about as strong as the theme's own text", () => {
    const out = darkText(rgb('#000000'), white, darkBg, anchors);
    const ratio = contrastRatio(out, darkBg);
    assert.ok(ratio >= MAX_TEXT - 0.1 && ratio <= MAX_TEXT + 1, String(ratio));
  });
  test('muted text stays muted: no more contrast than it had, but at least AA', () => {
    const muted = darkText(rgb('#777777'), white, darkBg, anchors);
    const body = darkText(rgb('#222222'), white, darkBg, anchors);
    assert.ok(contrastRatio(muted, darkBg) >= MIN_TEXT);
    assert.ok(contrastRatio(muted, darkBg) < contrastRatio(body, darkBg), 'the hierarchy survives');
  });
  test('colored text keeps its hue and at least the contrast it had', () => {
    for (const hex of ['#d32f2f', '#1565c0', '#2e7d32', '#6a1b9a', '#e65100']) {
      const fg = rgb(hex);
      const out = darkText(fg, white, darkBg, anchors);
      assert.ok(contrastRatio(out, darkBg) >= Math.min(Math.max(contrastRatio(fg, white), MIN_TEXT), MAX_TEXT) - 0.01, hex);
      assert.ok(hueGap(out, fg) < 15, `${hex} hue kept`);
    }
  });
  test('text the sender hid in its background stays hidden', () => {
    assert.deepEqual(darkText(rgb('#ffffff'), white, darkBg, anchors), darkBg);
    assert.deepEqual(darkText(rgb('#fefefe'), white, darkBg, anchors), darkBg);
  });
  test('text that already reads on its new background is left alone', () => {
    const fg = rgb('#ffffff');
    const button = rgb('#1a237e');
    assert.equal(darkText(fg, button, button, anchors), fg);
  });
  test('faint text as sent comes out readable', () => {
    const out = darkText(rgb('#cccccc'), white, darkBg, anchors);
    assert.ok(contrastRatio(out, darkBg) >= MIN_TEXT);
  });
});

describe('lightenTo', () => {
  test('reaches the target on any dark background, falling back to white', () => {
    for (const bg of ['#000000', '#0f0f11', '#3a3a3a', '#5a2d82']) {
      for (const target of [3, 4.5, 7]) {
        const out = lightenTo(rgb('#0d47a1'), rgb(bg), target, anchors.textTint);
        const best = contrastRatio(rgb('#ffffff'), rgb(bg));
        assert.ok(contrastRatio(out, rgb(bg)) >= Math.min(target, best) - 0.01, `${bg} ${target}`);
      }
    }
  });
});

describe('darkBorder', () => {
  const white = rgb('#ffffff');
  const darkBg = rgb('#0f0f11');
  test('a light divider becomes a subtle dark one', () => {
    const out = darkBorder(rgb('#dddddd'), white, darkBg, anchors);
    assert.ok(L(out) <= PIVOT);
    assert.ok(contrastRatio(out, darkBg) > 1.05, 'still visible');
  });
  test('a black line is lightened to stay visible, but only to a line\'s contrast', () => {
    const out = darkBorder(rgb('#000000'), white, darkBg, anchors);
    const ratio = contrastRatio(out, darkBg);
    assert.ok(ratio >= 3 - 0.01 && ratio < 4, String(ratio));
  });
});

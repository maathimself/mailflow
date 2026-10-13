// OKLCH color math for dark email bodies (#228).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rgbToOklch, oklchToRgb, formatRgb } from './oklch.js';

const close = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} is not within ${tolerance} of ${expected}`);

describe('rgbToOklch', () => {
  test('matches reference values', () => {
    // Reference values from the CSS Color 4 specification's conversions.
    const white = rgbToOklch({ r: 255, g: 255, b: 255 });
    close(white.L, 1, 1e-4, 'white L');
    close(white.C, 0, 1e-4, 'white C');
    const black = rgbToOklch({ r: 0, g: 0, b: 0 });
    close(black.L, 0, 1e-6, 'black L');
    const red = rgbToOklch({ r: 255, g: 0, b: 0 });
    close(red.L, 0.628, 0.001, 'red L');
    close(red.C, 0.2577, 0.001, 'red C');
    close(red.h, 29.23, 0.05, 'red h');
    const blue = rgbToOklch({ r: 0, g: 0, b: 255 });
    close(blue.L, 0.452, 0.001, 'blue L');
    close(blue.h, 264.05, 0.05, 'blue h');
  });
});

describe('oklchToRgb', () => {
  test('round-trips every color sRGB can show', () => {
    for (let r = 0; r <= 255; r += 51) {
      for (let g = 0; g <= 255; g += 51) {
        for (let b = 0; b <= 255; b += 51) {
          assert.deepEqual(oklchToRgb(rgbToOklch({ r, g, b })), { r, g, b });
        }
      }
    }
  });
  test('reduces chroma, not lightness or hue, for a color outside sRGB', () => {
    // A vivid yellow made dark has far more chroma than sRGB can show at that lightness.
    const yellow = rgbToOklch({ r: 255, g: 220, b: 0 });
    const dark = oklchToRgb({ L: 0.3, C: yellow.C, h: yellow.h });
    const back = rgbToOklch(dark);
    close(back.L, 0.3, 0.005, 'lightness kept');
    close(back.h, yellow.h, 3, 'hue kept');
    assert.ok(back.C < yellow.C, 'chroma reduced');
  });
  test('clamps lightness to 0-1', () => {
    assert.deepEqual(oklchToRgb({ L: 1.5, C: 0, h: 0 }), { r: 255, g: 255, b: 255 });
    assert.deepEqual(oklchToRgb({ L: -1, C: 0, h: 0 }), { r: 0, g: 0, b: 0 });
  });
});

test('formatRgb', () => {
  assert.equal(formatRgb({ r: 1.4, g: 2.6, b: 255 }), 'rgb(1, 3, 255)');
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compositeColors,
  contrastRatio,
  formatCssColor,
  hslToRgb,
  isNeutralColor,
  mixColors,
  parseCssColor,
  relativeLuminance,
  repairColorContrast,
  rgbToHsl,
} from './emailColors.js';

const within = (actual, expected, tolerance = 0.01) =>
  Math.abs(actual - expected) <= tolerance;

describe('CSS color parsing and formatting', () => {
  it('parses normalized solid CSS color forms', () => {
    assert.deepEqual(parseCssColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
    assert.deepEqual(parseCssColor('#1234'), { r: 17, g: 34, b: 51, a: 68 / 255 });
    assert.deepEqual(parseCssColor('#112233'), { r: 17, g: 34, b: 51, a: 1 });
    assert.deepEqual(parseCssColor('#11223380'), { r: 17, g: 34, b: 51, a: 128 / 255 });
    assert.deepEqual(parseCssColor('rgb(17, 34, 51)'), { r: 17, g: 34, b: 51, a: 1 });
    assert.deepEqual(parseCssColor('rgba(17, 34, 51, 0.5)'), { r: 17, g: 34, b: 51, a: 0.5 });
    assert.deepEqual(parseCssColor('rgb(17 34 51)'), { r: 17, g: 34, b: 51, a: 1 });
    assert.deepEqual(parseCssColor('rgb(17 34 51 / 50%)'), { r: 17, g: 34, b: 51, a: 0.5 });
    assert.equal(parseCssColor('transparent').a, 0);
  });

  it('rejects non-solid and non-finite CSS colors', () => {
    for (const value of [
      'var(--unknown)',
      'rgb(Infinity, 0, 0)',
      'rgb(NaN, 0, 0)',
      'rgb(0x10, 0, 0)',
      'rgb(0b10000, 0, 0)',
      'rgb(0o20, 0, 0)',
      'rgba(1, 2, 3, 0x1)',
      'rgb(1 2 3 extra)',
      'red',
    ]) {
      assert.equal(parseCssColor(value), null);
    }
  });

  it('formats opaque and transparent colors with bounded precision', () => {
    assert.equal(formatCssColor({ r: 17.2, g: 34.8, b: 51.4, a: 1 }), 'rgb(17, 35, 51)');
    assert.equal(formatCssColor({ r: 17, g: 34, b: 51, a: 0.123456 }), 'rgba(17, 34, 51, 0.1235)');
  });
});

describe('color math', () => {
  it('uses WCAG luminance and contrast with alpha compositing', () => {
    assert.equal(contrastRatio(parseCssColor('#000'), parseCssColor('#fff')), 21);
    assert.ok(Math.abs(relativeLuminance(parseCssColor('#777')) - 0.1844749945) < 1e-9);
    assert.deepEqual(compositeColors(parseCssColor('rgba(255,0,0,.5)'), parseCssColor('#fff')), {
      r: 255, g: 127.5, b: 127.5, a: 1,
    });
  });

  it('round-trips reference RGB colors through HSL', () => {
    for (const value of ['#000', '#fff', '#777', '#f00', '#336699']) {
      const original = parseCssColor(value);
      const roundTrip = hslToRgb(rgbToHsl(original));
      assert.ok(within(roundTrip.r, original.r), `${value} red channel`);
      assert.ok(within(roundTrip.g, original.g), `${value} green channel`);
      assert.ok(within(roundTrip.b, original.b), `${value} blue channel`);
    }
  });

  it('interpolates RGB and alpha while retaining exact endpoints', () => {
    const a = { r: 1, g: 2, b: 3, a: 0.25 };
    const b = { r: 101, g: 102, b: 103, a: 0.75 };
    assert.deepEqual(mixColors(a, b, 0), a);
    assert.deepEqual(mixColors(a, b, 1), b);
    assert.deepEqual(mixColors(a, b, 0.5), { r: 51, g: 52, b: 53, a: 0.5 });
  });
});

describe('neutrality and contrast repair', () => {
  it('uses exact neutral saturation thresholds by role', () => {
    const atBackgroundThreshold = hslToRgb({ h: 210, s: 0.12, l: 0.5 });
    const aboveBackgroundThreshold = hslToRgb({ h: 210, s: 0.121, l: 0.5 });
    const atForegroundThreshold = hslToRgb({ h: 210, s: 0.24, l: 0.5 });
    const aboveForegroundThreshold = hslToRgb({ h: 210, s: 0.241, l: 0.5 });

    assert.equal(isNeutralColor(atBackgroundThreshold, 'background'), true);
    assert.equal(isNeutralColor(aboveBackgroundThreshold, 'background'), false);
    assert.equal(isNeutralColor(atForegroundThreshold, 'foreground'), true);
    assert.equal(isNeutralColor(aboveForegroundThreshold, 'foreground'), false);

    const justAboveBackground = hslToRgb({ h: 0, s: 0.12 + 5e-13, l: 0.5 });
    const justAboveForeground = hslToRgb({ h: 0, s: 0.24 + 5e-13, l: 0.5 });
    assert.ok(rgbToHsl(justAboveBackground).s > 0.12);
    assert.ok(rgbToHsl(justAboveForeground).s > 0.24);
    assert.equal(isNeutralColor(justAboveBackground, 'background'), false);
    assert.equal(isNeutralColor(justAboveForeground, 'foreground'), false);
  });

  it('makes the minimum lightness change needed for contrast', () => {
    const foreground = parseCssColor('#777');
    const background = parseCssColor('#fff');
    const repaired = repairColorContrast(foreground, background, 4.5);
    const originalLightness = rgbToHsl(foreground).l;

    assert.ok(Math.abs(rgbToHsl(repaired).l - originalLightness) < originalLightness);
    assert.ok(Math.abs(rgbToHsl(repaired).l - originalLightness) < 1 - originalLightness);
    assert.ok(contrastRatio(repaired, background) >= 4.5);
  });

  it('preserves hue and saturation when repairing a saturated color', () => {
    const foreground = parseCssColor('#c06080');
    const background = parseCssColor('#fff');
    const repaired = repairColorContrast(foreground, background, 4.5);
    const source = rgbToHsl(foreground);
    const result = rgbToHsl(repaired);

    assert.ok(contrastRatio(repaired, background) >= 4.5);
    assert.ok(Math.abs(result.h - source.h) <= 0.001);
    assert.ok(Math.abs(result.s - source.s) <= 0.001);
    assert.notEqual(result.l, source.l);
  });

  it('returns null when alpha compositing cannot reach the target contrast', () => {
    assert.equal(repairColorContrast(
      parseCssColor('rgba(0, 0, 0, 0.1)'),
      parseCssColor('#fff'),
      4.5,
    ), null);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES } from '../themes.js';
import { contrastRatio, parseCssColor, relativeLuminance } from './emailColors.js';
import { buildEmailPalette } from './emailPalette.js';

const paletteValues = vars => ({
  background: vars['--bg-secondary'],
  elevated: vars['--bg-elevated'],
  text: vars['--text-primary'],
  mutedText: vars['--text-secondary'],
  accent: vars['--accent'],
  border: vars['--border'],
});

const dark = THEMES.dark.vars;

describe('buildEmailPalette', () => {
  it('builds readable, fingerprinted palettes for every built-in theme', () => {
    for (const [name, theme] of Object.entries(THEMES)) {
      const palette = buildEmailPalette(paletteValues(theme.vars), theme.vars, dark);
      assert.ok(['dark', 'light'].includes(palette.scheme), `${name} scheme`);
      assert.ok(contrastRatio(palette.text, palette.background) >= 4.5, `${name} text`);
      assert.ok(contrastRatio(palette.accent, palette.background) >= 4.5, `${name} accent`);
      assert.ok(contrastRatio(palette.border, palette.background) >= 3, `${name} border`);
      assert.equal(palette.fingerprint.split('|').length, 6, `${name} fingerprint`);
    }
  });

  it('keeps a valid custom accent over the selected built-in value', () => {
    const palette = buildEmailPalette({ accent: '#ffdd00' }, THEMES.dark.vars, dark);
    assert.deepEqual(palette.accent, parseCssColor('#ffdd00'));
  });

  it('accepts a nested value after a resolver normalizes it to RGB', () => {
    const resolve = value => value === 'var(--nested-accent)' ? 'rgb(30, 200, 220)' : value;
    const palette = buildEmailPalette({ accent: resolve('var(--nested-accent)') }, THEMES.dark.vars, dark);
    assert.deepEqual(palette.accent, parseCssColor('rgb(30, 200, 220)'));
  });

  it('uses the selected built-in value for one invalid custom role', () => {
    const palette = buildEmailPalette({ accent: 'not-a-color' }, THEMES.dark.vars, dark);
    assert.deepEqual(palette.accent, parseCssColor('#7c6af7'));
  });

  it('uses the selected built-in palette when every custom role is invalid', () => {
    const invalid = Object.fromEntries(Object.keys(paletteValues(dark)).map(role => [role, 'var(--missing)']));
    const palette = buildEmailPalette(invalid, THEMES.light.vars, dark);
    assert.deepEqual(palette.background, parseCssColor('#fff'));
    assert.deepEqual(palette.text, parseCssColor('#1a1a2e'));
  });

  it('uses the default dark palette when a selected built-in value is invalid', () => {
    const builtIn = { ...THEMES.dark.vars, '--accent': 'invalid' };
    const palette = buildEmailPalette({}, builtIn, dark);
    assert.deepEqual(palette.accent, parseCssColor('#7c6af7'));
  });

  it('rejects translucent surfaces and uses the next opaque fallback', () => {
    const palette = buildEmailPalette({ background: 'rgba(1, 2, 3, 0.5)' }, THEMES.light.vars, dark);
    assert.deepEqual(palette.background, parseCssColor('#fff'));
  });

  it('minimally repairs valid low-contrast custom foreground roles', () => {
    const palette = buildEmailPalette({
      background: '#ffffff',
      text: '#777777',
      accent: '#888888',
      border: '#dddddd',
    }, THEMES.light.vars, dark);
    assert.ok(contrastRatio(palette.text, palette.background) >= 4.5);
    assert.ok(contrastRatio(palette.accent, palette.background) >= 4.5);
    assert.ok(contrastRatio(palette.border, palette.background) >= 3);
    assert.notDeepEqual(palette.text, parseCssColor('#777'));
    assert.notDeepEqual(palette.accent, parseCssColor('#888'));
    assert.notDeepEqual(palette.border, parseCssColor('#ddd'));
  });

  it('chooses dark below and light at the background luminance threshold', () => {
    const darkPalette = buildEmailPalette({ background: '#555555' }, THEMES.dark.vars, dark);
    const lightPalette = buildEmailPalette({ background: '#a0a0a0' }, THEMES.dark.vars, dark);
    assert.ok(relativeLuminance(darkPalette.background) < 0.35);
    assert.equal(darkPalette.scheme, 'dark');
    assert.ok(relativeLuminance(lightPalette.background) >= 0.35);
    assert.equal(lightPalette.scheme, 'light');
  });
});

// Dark email bodies (#228): which bodies are shown dark.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isDarkTheme, canShowDark, showDark } from './darkScheme.js';

const DARK_DESIGN = { html: '<p>x</p>', darkCss: '@media (min-width: 0px){p{color:#eee}}', lightOnly: false };
const PLAIN_HTML = { html: '<p>Hello</p>', darkCss: null, lightOnly: false };
const TEXT = { html: null, text: 'hi' };

describe('isDarkTheme', () => {
  test('goes by the background, not the name', () => {
    assert.equal(isDarkTheme('dark'), true);
    assert.equal(isDarkTheme('nord'), true);
    for (const light of ['light', 'catppuccin_latte', 'parchment', 'winxp', 'win9x']) assert.equal(isDarkTheme(light), false, light);
  });
});

describe('which bodies can be shown dark', () => {
  test('plain text, and any HTML that does not ask to stay light', () => {
    assert.equal(canShowDark(TEXT), true);
    assert.equal(canShowDark(DARK_DESIGN), true);
    assert.equal(canShowDark(PLAIN_HTML), true, 'recolored by MailFlow');
    assert.equal(canShowDark({ ...DARK_DESIGN, darkCss: null, lightOnly: true }), false);
    assert.equal(canShowDark({ ...PLAIN_HTML, lightOnly: true }), false);
    assert.equal(canShowDark(null), false);
  });
});

describe('shown dark', () => {
  test('plain text follows a dark theme unless switched back', () => {
    assert.equal(showDark({ body: TEXT, themeKey: 'dark', setting: false }), true);
    assert.equal(showDark({ body: TEXT, themeKey: 'dark', setting: false, override: 'original' }), false);
  });

  test('HTML follows the setting, or the message toggled either way', () => {
    assert.equal(showDark({ body: DARK_DESIGN, themeKey: 'dark', setting: false }), false);
    assert.equal(showDark({ body: DARK_DESIGN, themeKey: 'dark', setting: true }), true);
    assert.equal(showDark({ body: DARK_DESIGN, themeKey: 'dark', setting: false, override: 'dark' }), true);
    assert.equal(showDark({ body: DARK_DESIGN, themeKey: 'dark', setting: true, override: 'original' }), false);
    assert.equal(showDark({ body: PLAIN_HTML, themeKey: 'dark', setting: true }), true);
    assert.equal(showDark({ body: { ...PLAIN_HTML, lightOnly: true }, themeKey: 'dark', setting: true, override: 'dark' }), false);
  });

  test('never in a light theme', () => {
    assert.equal(showDark({ body: TEXT, themeKey: 'light', setting: true }), false);
    assert.equal(showDark({ body: DARK_DESIGN, themeKey: 'parchment', setting: true, override: 'dark' }), false);
  });
});

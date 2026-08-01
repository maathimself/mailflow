import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

describe('CommandPalette source wiring', () => {
  const source = fs.readFileSync(new URL('./CommandPalette.jsx', import.meta.url), 'utf8');
  const continuation = fs.readFileSync(new URL('./CommandContinuation.jsx', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../index.css', import.meta.url), 'utf8');

  it('consumes the shared runtime and required accessible semantics', () => {
    assert.match(source, /useCommandRuntimeContext\(\)/);
    for (const token of [
      'role="dialog"', 'aria-modal="true"', 'role="combobox"', 'aria-controls="command-palette-results"',
      'aria-activedescendant', 'role="listbox"', 'role="option"', 'aria-live="polite"',
    ]) assert.ok(source.includes(token), `missing ${token}`);
  });

  it('uses registry results, alias hints, shortcut formatting, and focus helpers', () => {
    assert.match(source, /registry\.search\(state\.query, context\)/);
    assert.match(source, /result\.matchedAlias/);
    assert.match(source, /formatCommandKey/);
    assert.match(source, /isRestorableFocus/);
    assert.match(source, /nextFocusIndex/);
  });

  it('closes directly so a rapid reopen cannot inherit a stale close request', () => {
    assert.match(source, /if \(continuation\) clearContinuation\(\);\s*else onClose\(\);/);
    assert.doesNotMatch(source, /closeRequested/);
  });

  it('keeps the active keyboard option inside the bounded scroll window', () => {
    assert.match(source, /scrollIntoView\(\{ block: 'nearest' \}\)/);
    assert.match(source, /\[state\.activeIndex\]/);
  });

  it('resumes continuations with their frozen account-scoped targets', () => {
    assert.match(continuation, /frozenTargetIds: continuation\.targetIds/);
    assert.match(continuation, /source: 'palette'/);
  });

  it('localizes and bounds continuation options inside the palette', () => {
    assert.match(continuation, /useTranslation\(\)/);
    assert.match(continuation, /aria-label=\{t\(continuation\.props\.titleKey\)\}/);
    assert.match(continuation, /className="command-palette__results"/);
  });

  it('uses the MailFlow search header, escape chip, and keyboard footer', () => {
    assert.match(source, /className="command-palette__search"/);
    assert.match(source, /<CommandIcon name="search"/);
    assert.match(source, /className="command-palette__escape">Esc<\/kbd>/);
    assert.match(source, /className="command-palette__footer"/);
    assert.match(source, /className="command-palette__hints"/);
    for (const key of ['navigate', 'select', 'close']) {
      assert.ok(source.includes(`commandPalette.hint.${key}`));
    }
  });

  it('keeps the approved 5.5-row viewport and theme-aware selected row', () => {
    assert.match(css, /\.command-palette__results\s*\{[^}]*max-height:\s*286px/);
    assert.match(css, /\.command-palette__row\s*\{[^}]*min-height:\s*52px/);
    assert.match(css, /\.command-palette__row\[aria-selected="true"\]\s*\{[^}]*var\(--accent-dim\)/);
  });
});

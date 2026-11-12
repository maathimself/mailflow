import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';

const css = postcss.parse(readFileSync(new URL('./gmail-layout.css', import.meta.url), 'utf8'));

test('every shell and list skin selector is opt-in', () => {
  css.walkRules(rule => {
    for (const selector of rule.selectors) {
      assert.ok(selector.startsWith('[data-mailflow-layout="gmail"] '), selector);
    }
  });
});

test('Gmail mobile toolbar wraps without reducing its touch targets', () => {
  const declarations = selector => {
    const values = {};
    css.walkRules(selector, rule => rule.walkDecls(decl => { values[decl.prop] = decl.value; }));
    return values;
  };
  const header = declarations('[data-mailflow-layout="gmail"] .mail-mobile-header');
  const buttons = declarations('[data-mailflow-layout="gmail"] .mail-mobile-header > button');
  assert.equal(header['flex-wrap'], 'wrap');
  assert.equal(buttons['min-width'], '44px');
  assert.equal(buttons['min-height'], '44px');
  assert.equal(header.overflow, undefined, 'controls must not be clipped');
  assert.equal(buttons.display, undefined, 'no controls are hidden');
});

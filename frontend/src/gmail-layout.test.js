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

const mediaRules = () => {
  const rules = [];
  css.walkAtRules('media', media => media.walkRules(rule => rules.push({ query: media.params, selector: rule.selector })));
  return rules;
};

test('row columns follow the measured pane width, never the viewport', () => {
  for (const { query, selector } of mediaRules()) {
    assert.doesNotMatch(selector, /\.mail-row-|\.mail-list-row/, `${selector} is sized by @media ${query}`);
  }
  const tiered = [];
  css.walkRules(/\.mail-row-/, rule => { if (rule.selector.includes('[data-pane-width=')) tiered.push(rule.selector); });
  assert.ok(tiered.some(selector => selector.includes('"medium"')));
  assert.ok(tiered.some(selector => selector.includes('"narrow"')));
});

test('a narrow list stacks subject under sender and date instead of squeezing it to nothing', () => {
  const narrow = name => {
    const values = {};
    css.walkRules(`[data-mailflow-layout="gmail"] .gmail-shell [data-pane-width="narrow"] ${name}`,
      rule => rule.walkDecls(decl => { values[decl.prop] = decl.value; }));
    return values;
  };
  assert.equal(narrow('.mail-row-heading').display, 'flex');
  assert.equal(narrow('.mail-row-content').display, 'block');
  assert.equal(narrow('.mail-row-sender').flex, '1 1 0');
  assert.equal(narrow('.mail-row-subject').display, undefined, 'the subject is never hidden');
  assert.equal(narrow('.mail-row-date').display, undefined, 'the date is never hidden');
});

test('the bulk toolbar wraps its actions instead of pushing them off the pane', () => {
  const values = {};
  css.walkRules('[data-mailflow-layout="gmail"] .mail-bulk-toolbar', rule => rule.walkDecls(decl => { values[decl.prop] = decl.value; }));
  assert.equal(values['flex-wrap'], 'wrap');
  assert.equal(values.overflow, undefined, 'actions must not be clipped');
});

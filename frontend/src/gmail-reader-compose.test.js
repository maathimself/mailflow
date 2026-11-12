import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';

const css = postcss.parse(readFileSync(new URL('./gmail-reader-compose.css', import.meta.url), 'utf8'));

test('every reader and compose skin selector is opt-in', () => {
  let rules = 0;
  css.walkRules(rule => {
    rules++;
    for (const selector of rule.selectors) {
      assert.ok(selector.startsWith('[data-mailflow-layout="gmail"] '), selector);
    }
  });
  assert.ok(rules > 20);
});

test('the skin uses theme colors and never styles email body contents', () => {
  css.walkRules(rule => {
    assert.doesNotMatch(rule.selector, /iframe|data-mailflow-email|ProseMirror|\.email-/);
  });
  css.walkDecls(declaration => {
    if (declaration.prop === 'font-family') assert.match(declaration.value, /^var\(--font-/);
    assert.doesNotMatch(declaration.value, /#[\da-f]{3,8}\b|\b(?:white|black)\b/i);
  });
});

test('the one-row reader toolbar needs a measured wide pane, not a wide viewport', () => {
  css.walkAtRules('media', media => assert.doesNotMatch(media.params, /min-width/, `@media ${media.params}`));
  let grids = 0;
  css.walkDecls('grid-template-columns', declaration => {
    grids++;
    for (const selector of declaration.parent.selectors) {
      assert.ok(selector.startsWith('[data-mailflow-layout="gmail"] [data-pane-width="wide"] '), selector);
    }
  });
  assert.equal(grids, 1);
});

test('a narrow reader gives the sender name the row and puts the date under it', () => {
  const values = {};
  css.walkRules('[data-mailflow-layout="gmail"] [data-pane-width="narrow"] .mail-reader-date',
    rule => rule.walkDecls(decl => { values[decl.prop] = decl.value; }));
  // Basis plus margin is the row's width: the block has flexShrink 0 and must not overhang.
  assert.equal(values['flex-basis'], `calc(100% - ${values['margin-left']})`);
});

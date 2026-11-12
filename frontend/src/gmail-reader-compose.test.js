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

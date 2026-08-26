import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scopeEmailCss } from './scopeEmailCss.js';

describe('scopeEmailCss Outlook root selectors', () => {
  it('puts a leading Outlook dark attribute on the generated root', () => {
    assert.match(
      scopeEmailCss('[data-ogsc] .copy { color:white }', 'email-test'),
      /\.email-test\[data-ogsc\] \.copy/,
    );
  });

  it('puts a leading Outlook background attribute on the generated root', () => {
    assert.match(
      scopeEmailCss('body[data-ogsb] > table { background:black }', 'email-test'),
      /\.email-test\[data-ogsb\] > table/,
    );
  });

  it('normalizes html, root, and body Outlook attributes onto the generated root', () => {
    for (const selector of [
      'html[data-ogsc] .copy',
      ':root[data-ogsc] .copy',
      'body[data-ogsc] .copy',
      'html body[data-ogsc] .copy',
      'html[data-ogsc] body .copy',
    ]) {
      assert.match(
        scopeEmailCss(`${selector} { color:white }`, 'email-test'),
        /\.email-test\[data-ogsc\] \.copy/,
        selector,
      );
    }
  });

  it('drops malformed selector lists instead of normalizing them into valid scoped CSS', () => {
    assert.doesNotMatch(
      scopeEmailCss('.bad,,.also { color:red }', 'email-test'),
      /bad|also/,
    );
  });
});

describe('scopeEmailCss renderer-local at-rules', () => {
  it('removes registration, ordering, and unknown at-rules instead of leaking global semantics', () => {
    const scoped = scopeEmailCss(`
      @property --app-accent { syntax: '<color>'; inherits: true; initial-value: red; }
      @counter-style app-counter { system: cyclic; symbols: 'x'; suffix: ' '; }
      @layer app-reset, sender;
      @starting-style { .card { opacity: 0; } }
      @unknown-global token;
      .copy { color: blue; }
    `, 'email-test');

    assert.doesNotMatch(scoped, /@property|@counter-style|@layer|@starting-style|@unknown-global/);
    assert.match(scoped, /\.email-test \.copy/);
  });

  it('keeps only responsive media and feature-query grouping rules', () => {
    const scoped = scopeEmailCss(`
      @media (max-width: 600px) { .column { display: block; } }
      @supports (display: grid) { .grid { display: grid; } }
    `, 'email-test');

    assert.match(scoped, /@media \(max-width: 600px\)/);
    assert.match(scoped, /@supports \(display: grid\)/);
    assert.match(scoped, /\.email-test \.column/);
    assert.match(scoped, /\.email-test \.grid/);
  });
});

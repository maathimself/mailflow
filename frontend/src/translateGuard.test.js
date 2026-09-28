// Run with: node --test src/translateGuard.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('index.html', () => {
  it('keeps browser translators off the React-owned UI', () => {
    // A translator rewriting React's text nodes crashes the app with
    // "Failed to execute 'removeChild' on 'Node'".
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    // On <html> rather than <body>, so the tab title in <head> is not translated either.
    assert.match(html, /<html[^>]*\btranslate="no"/);
    assert.match(html, /<body[^>]*\bclass="[^"]*\bnotranslate\b/);
  });
});

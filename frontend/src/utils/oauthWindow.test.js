import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openOAuthWindow } from './oauthWindow.js';

test('opens the consent route through a temporary anchor with rel="opener"', () => {
  const clicked = [];
  const body = new Set();
  globalThis.document = {
    createElement: (tag) => {
      assert.equal(tag, 'a');
      return { click() { clicked.push({ href: this.href, target: this.target, rel: this.rel, attached: body.has(this) }); } };
    },
    body: { appendChild: (el) => body.add(el), removeChild: (el) => body.delete(el) },
  };
  try {
    openOAuthWindow('/oauth/google?login_hint=a%40gmail.com');
    assert.deepEqual(clicked, [{ href: '/oauth/google?login_hint=a%40gmail.com', target: '_blank', rel: 'opener', attached: true }]);
    assert.equal(body.size, 0, 'the anchor is removed again');
  } finally {
    delete globalThis.document;
  }
});

test('ignores anything that is not a same-origin /oauth/ path', () => {
  let created = 0;
  globalThis.document = { createElement: () => { created += 1; return { click() {} }; }, body: { appendChild() {}, removeChild() {} } };
  try {
    for (const href of [null, '', 'https://evil.example/oauth/google', '//evil.example/oauth/google', 'javascript:alert(1)', '/api/accounts']) {
      openOAuthWindow(href);
    }
    assert.equal(created, 0);
  } finally {
    delete globalThis.document;
  }
});

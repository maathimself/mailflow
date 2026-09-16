// Render test for the top-level error boundary (#441).
//
// The bug it exists for is a blank page: React 18 unmounts the whole tree when a component
// throws during render, so without a boundary the user sees an empty document and can tell
// us nothing about what broke. These tests assert the boundary actually catches, that the
// fallback shows the error text, and that a healthy tree is passed through untouched.
//
// The harness mirrors MessagePane.render.test.js: node --test cannot parse JSX, so the
// loader hook transforms .jsx with sucrase.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM, VirtualConsole } from 'jsdom';
import { transform } from 'sucrase';

// An exception thrown inside a DOM event listener does not propagate out of element.click():
// per spec jsdom "reports" it instead, and React does not route handler errors to error
// boundaries either. So a broken click handler is invisible to a naive test — the fallback
// stays on screen and the assertion passes while the handler actually blew up. Capture what
// jsdom reports so the tests can assert the handlers are genuinely clean.
const jsdomErrors = [];
const virtualConsole = new VirtualConsole();
// jsdom 30: forwardTo replaced sendTo; jsdomErrors:'none' keeps reported listener exceptions
// out of the real console so they surface only through the listener below.
virtualConsole.forwardTo(console, { jsdomErrors: 'none' });
virtualConsole.on('jsdomError', (err) => jsdomErrors.push(err));

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.jsx')) {
      const code = readFileSync(new URL(url), 'utf8');
      const out = transform(code, { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: out.code };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true, virtualConsole });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const ErrorBoundary = (await import('./ErrorBoundary.jsx')).default;

function Boom() {
  throw new Error('kaboom from a child');
}

async function mount(child) {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  await React.act(async () => {
    createRoot(host).render(React.createElement(ErrorBoundary, null, child));
  });
  return host;
}

describe('ErrorBoundary (#441)', () => {
  test('renders children untouched when nothing throws', async () => {
    const host = await mount(React.createElement('p', null, 'healthy tree'));
    assert.match(host.textContent, /healthy tree/);
    assert.doesNotMatch(host.textContent, /hit an error/);
  });

  test('catches a render error instead of leaving a blank page', async () => {
    // The whole point: the document must not end up empty.
    const errors = [];
    const realError = console.error;
    console.error = (...args) => errors.push(args);
    try {
      const host = await mount(React.createElement(Boom));
      assert.notEqual(host.textContent.trim(), '', 'boundary left the page blank');
      assert.match(host.textContent, /MailFlow hit an error and stopped/);
    } finally {
      console.error = realError;
    }
  });

  test('shows the underlying error message so the user can report it', async () => {
    const realError = console.error;
    console.error = () => {};
    try {
      const host = await mount(React.createElement(Boom));
      assert.match(host.textContent, /kaboom from a child/);
    } finally {
      console.error = realError;
    }
  });

  // Click Copy under a given navigator.clipboard shape and return whatever jsdom reported
  // the handler throwing. jsdom "reports" a listener exception rather than surfacing it from
  // click(), and React does not route handler errors to boundaries, so the report log is
  // the only place a broken handler is visible from a test.
  async function clickCopyWith(clipboardValue) {
    const realError = console.error;
    console.error = () => {};
    const hadClipboard = 'clipboard' in globalThis.navigator;
    const savedClipboard = globalThis.navigator.clipboard;
    try {
      Object.defineProperty(globalThis.navigator, 'clipboard', { value: clipboardValue, configurable: true });
      const host = await mount(React.createElement(Boom));
      const copy = [...host.querySelectorAll('button')].find(b => b.textContent === 'Copy details');
      assert.ok(copy, 'expected a Copy details button');
      const before = jsdomErrors.length;
      await React.act(async () => { copy.click(); });
      const reported = jsdomErrors.slice(before).map(e => String(e?.detail?.message || e?.message || e));
      return { host, copy, reported };
    } finally {
      if (hadClipboard) Object.defineProperty(globalThis.navigator, 'clipboard', { value: savedClipboard, configurable: true });
      else delete globalThis.navigator.clipboard;
      console.error = realError;
    }
  }

  test('Copy details short-circuits cleanly when navigator.clipboard is absent', async () => {
    // Plain http:// on a LAN has no navigator.clipboard. Optional chaining skips the whole
    // chain here, so nothing should be reported and the fallback stays up.
    const { host, copy, reported } = await clickCopyWith(undefined);
    assert.deepEqual(reported, [], `Copy handler threw: ${reported.join(' | ')}`);
    assert.match(host.textContent, /kaboom from a child/);
    assert.equal(copy.textContent, 'Copy details');
  });

  test('Copy details survives a writeText that returns a non-Promise', async () => {
    // The one case optional chaining does NOT protect: writeText exists but hands back
    // undefined, so a bare `.then` on the result throws inside the handler. This is what the
    // explicit promise check in handleCopy is for. Standard browsers never do this, but the
    // fallback page cannot afford to assume a conformant environment.
    const { host, reported } = await clickCopyWith({ writeText: () => undefined });
    assert.deepEqual(reported, [], `Copy handler threw: ${reported.join(' | ')}`);
    assert.match(host.textContent, /kaboom from a child/);
  });

  test('offers a way to recover', async () => {
    const realError = console.error;
    console.error = () => {};
    try {
      const host = await mount(React.createElement(Boom));
      const labels = [...host.querySelectorAll('button')].map(b => b.textContent);
      assert.ok(labels.includes('Reload'), `expected a Reload button, got ${JSON.stringify(labels)}`);
    } finally {
      console.error = realError;
    }
  });
});

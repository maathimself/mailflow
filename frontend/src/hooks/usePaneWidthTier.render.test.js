// The hook writes data-pane-width and the Gmail stylesheets select on it. Each side is tested
// on its own elsewhere; this mounts the hook and checks that what it writes is what they read.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
const observers = [];
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  ResizeObserver: class {
    constructor(callback) { this.callback = callback; this.connected = true; observers.push(this); }
    observe() {}
    disconnect() { this.connected = false; }
  },
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { usePaneWidthTier } = await import('./usePaneWidthTier.js');

// jsdom lays nothing out, so clientWidth is always 0: the test supplies the pane's width.
let width = 0;
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return width; } });

function Pane({ enabled }) {
  return createElement('div', { id: 'pane', ref: usePaneWidthTier(enabled) });
}

async function mount(enabled) {
  const root = createRoot(document.getElementById('root'));
  await act(async () => { root.render(createElement(Pane, { enabled })); });
  return root;
}

const resize = (to) => act(async () => {
  width = to;
  for (const o of observers) if (o.connected) o.callback();
});

const css = ['../gmail-layout.css', '../gmail-reader-compose.css']
  .map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');

test('the pane carries the tier the stylesheets select on, and follows a resize', async () => {
  width = 383;
  const root = await mount(true);
  const pane = document.getElementById('pane');
  const seen = new Set();
  for (const [to, tier] of [[383, 'narrow'], [700, 'medium'], [868, 'wide']]) {
    await resize(to);
    assert.equal(pane.getAttribute('data-pane-width'), tier);
    seen.add(tier);
  }
  for (const tier of seen) assert.ok(css.includes(`[data-pane-width="${tier}"]`), `no rule for the ${tier} tier`);
  for (const [, tier] of css.matchAll(/\[data-pane-width="([^"]+)"\]/g)) {
    assert.ok(seen.has(tier), `the stylesheets select a tier the hook never writes: ${tier}`);
  }

  // A pane that is hidden keeps its last tier rather than flickering to none.
  await resize(0);
  assert.equal(pane.getAttribute('data-pane-width'), 'wide');

  await act(async () => { root.unmount(); });
  assert.equal(pane.hasAttribute('data-pane-width'), false);
});

test('outside the Gmail layout the pane is left alone', async () => {
  width = 383;
  const root = await mount(false);
  assert.equal(document.getElementById('pane').hasAttribute('data-pane-width'), false);
  await act(async () => { root.unmount(); });
});

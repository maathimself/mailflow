import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// A real DOM, because tier 2 depends on actually appending a textarea, selecting it and
// removing it again. Stubbing that out would test the mock rather than the code.
const dom = new JSDOM('<!doctype html><html><body><input id="focused"></body></html>');
const { window } = dom;
Object.defineProperty(globalThis, 'document', { value: window.document, configurable: true, writable: true });
Object.defineProperty(globalThis, 'getSelection', { value: () => window.getSelection(), configurable: true, writable: true });

let navigatorStub;
let execCalls;
let execResult;

function setNavigator(clipboard, userAgent = 'Mozilla/5.0 (X11; Linux x86_64)') {
  navigatorStub = { userAgent, ...(clipboard ? { clipboard } : {}) };
  Object.defineProperty(globalThis, 'navigator', { value: navigatorStub, configurable: true, writable: true });
}

beforeEach(() => {
  execCalls = [];
  execResult = true;
  window.document.execCommand = (cmd) => {
    // Capture what was selected at the moment of the copy, which is the only way to know
    // the textarea was still in the document and still selected when it mattered.
    const active = window.document.activeElement;
    execCalls.push({ cmd, value: active && 'value' in active ? active.value : null });
    return execResult;
  };
  setNavigator(null);
});

afterEach(() => {
  // Nothing may be left behind in the document.
  assert.equal(window.document.querySelectorAll('textarea').length, 0,
    'the scratch textarea must always be removed');
});

const { copyToClipboard, selectElementText } = await import('./clipboard.js');

describe('copyToClipboard: modern API', () => {
  test('uses navigator.clipboard when it exists', async () => {
    const written = [];
    setNavigator({ writeText: async (v) => { written.push(v); } });
    const res = await copyToClipboard('hello');
    assert.deepEqual(res, { ok: true, method: 'async' });
    assert.deepEqual(written, ['hello']);
    assert.equal(execCalls.length, 0, 'must not touch the legacy path when the modern one worked');
  });

  test('stringifies non-string input rather than passing it through', async () => {
    const written = [];
    setNavigator({ writeText: async (v) => { written.push(v); } });
    await copyToClipboard(42);
    await copyToClipboard(null);
    await copyToClipboard(undefined);
    assert.deepEqual(written, ['42', '', '']);
  });
});

describe('copyToClipboard: non-secure context (#416)', () => {
  test('falls back to execCommand when navigator.clipboard is undefined', async () => {
    // The reported case: plain http over Tailscale, so the whole clipboard object is gone.
    setNavigator(null);
    const res = await copyToClipboard('https://mail.example/invite/abc');
    assert.deepEqual(res, { ok: true, method: 'execCommand' });
    assert.equal(execCalls.length, 1);
    assert.equal(execCalls[0].cmd, 'copy');
    assert.equal(execCalls[0].value, 'https://mail.example/invite/abc',
      'the textarea must still hold the value and be focused when copy runs');
  });

  test('does not throw when navigator itself is missing clipboard entirely', async () => {
    setNavigator(null);
    await assert.doesNotReject(() => copyToClipboard('x'));
  });

  test('falls back when the modern API exists but rejects', async () => {
    // Permission denied, or the document is not focused.
    setNavigator({ writeText: async () => { throw new Error('NotAllowedError'); } });
    const res = await copyToClipboard('after rejection');
    assert.deepEqual(res, { ok: true, method: 'execCommand' });
    assert.equal(execCalls[0].value, 'after rejection');
  });
});

describe('copyToClipboard: total failure', () => {
  test('reports failure instead of throwing when both paths fail', async () => {
    setNavigator(null);
    execResult = false;
    const res = await copyToClipboard('nope');
    assert.deepEqual(res, { ok: false, method: null });
  });

  test('reports failure when execCommand throws', async () => {
    setNavigator(null);
    window.document.execCommand = () => { throw new Error('gone'); };
    const res = await copyToClipboard('nope');
    assert.deepEqual(res, { ok: false, method: null });
  });
});

describe('copyToClipboard: housekeeping', () => {
  test('restores focus to whatever was focused before', async () => {
    setNavigator(null);
    const input = window.document.getElementById('focused');
    input.focus();
    assert.equal(window.document.activeElement, input);
    await copyToClipboard('x');
    assert.equal(window.document.activeElement, input, 'copying must not steal focus');
  });

  test('removes the scratch textarea even when the copy fails', async () => {
    setNavigator(null);
    window.document.execCommand = () => { throw new Error('boom'); };
    await copyToClipboard('x');
    // The afterEach assertion is the real check; this documents the intent.
    assert.equal(window.document.querySelectorAll('textarea').length, 0);
  });

  test('takes the iOS selection path without breaking', async () => {
    // iOS Safari ignores select() on a readonly textarea, so the code takes a different
    // route there. Exercise it so the branch cannot rot unnoticed.
    setNavigator(null, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)');
    const res = await copyToClipboard('ios value');
    assert.equal(res.ok, true);
    assert.equal(execCalls[0].cmd, 'copy');
  });
});

describe('selectElementText', () => {
  test('selects the element contents', () => {
    const el = window.document.createElement('code');
    el.textContent = 'https://mail.example/invite/abc';
    window.document.body.appendChild(el);
    assert.equal(selectElementText(el), true);
    assert.equal(window.getSelection().toString(), 'https://mail.example/invite/abc');
    el.remove();
  });

  test('is safe on a missing or detached element', () => {
    assert.equal(selectElementText(null), false);
    assert.equal(selectElementText(undefined), false);
    assert.equal(selectElementText({}), false);
  });
});

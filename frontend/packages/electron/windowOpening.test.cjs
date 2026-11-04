const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { configureWindowOpening, isPrintWindow } = require('./windowOpening.cjs');

const host = 'https://mail.example.test';
const printRequest = {
  url: 'about:blank', frameName: 'mailflow-print-1', referrer: { url: `${host}/inbox` },
};

test('permits only named blank print windows from the configured host', () => {
  assert.equal(isPrintWindow(printRequest, host, host), true);
  assert.equal(isPrintWindow({ ...printRequest, referrer: undefined }, host, host), true);
  assert.equal(isPrintWindow({ ...printRequest, referrer: { url: '' } }, host, host), true);
  for (const change of [
    { url: `${host}/inbox` }, { url: 'javascript:alert(1)' },
    { frameName: '_blank' }, { frameName: 'mailflow-print-1-other' },
    { referrer: { url: 'https://mail.example.test.attacker.test' } },
    { referrer: { url: 'https://idp.example.test' } },
  ]) {
    assert.equal(isPrintWindow({ ...printRequest, ...change }, host, host), false);
  }
  assert.equal(isPrintWindow(printRequest, null, host), false);
  assert.equal(isPrintWindow(printRequest, host, 'https://idp.example.test'), false);
  assert.equal(isPrintWindow(printRequest, host, 'file:///setup.html'), false);
});

function fakeContents() {
  const contents = new EventEmitter();
  contents.setWindowOpenHandler = (handler) => { contents.openWindow = handler; };
  contents.getURL = () => `${host}/inbox`;
  return contents;
}

test('opens print windows and continues routing external links to the browser', () => {
  const contents = fakeContents();
  const opened = [];
  let configuredHost = host;
  configureWindowOpening(contents, {
    getHost: () => configuredHost,
    isAllowedExternalUrl: (url) => /^https?:/.test(url),
    openExternal: (url) => opened.push(url),
  });
  const printWindow = contents.openWindow(printRequest);
  assert.equal(printWindow.action, 'allow');
  assert.deepEqual(printWindow.overrideBrowserWindowOptions.webPreferences, {
    preload: undefined, sandbox: true, contextIsolation: true, nodeIntegration: false,
    nodeIntegrationInSubFrames: false, webviewTag: false,
  });
  assert.deepEqual(contents.openWindow({ url: 'https://example.test' }), { action: 'deny' });
  assert.deepEqual(contents.openWindow({ url: 'file:///secret' }), { action: 'deny' });
  assert.deepEqual(contents.openWindow({ ...printRequest, frameName: '_blank' }), { action: 'deny' });
  assert.deepEqual(opened, ['https://example.test']);
  configuredHost = 'https://other.example.test';
  assert.deepEqual(contents.openWindow(printRequest), { action: 'deny' });

  const child = { webContents: fakeContents() };
  contents.emit('did-create-window', child);
  assert.deepEqual(child.webContents.openWindow(printRequest), { action: 'deny' });
  assert.deepEqual(child.webContents.openWindow({ url: 'https://link.test' }), { action: 'deny' });
  let prevented = 0;
  const event = { preventDefault: () => { prevented++; } };
  child.webContents.emit('will-navigate', event, 'https://navigation.test');
  child.webContents.emit('will-navigate', event, 'file:///secret');
  child.webContents.emit('will-redirect', event, 'https://redirect.test');
  assert.equal(prevented, 3);
  assert.deepEqual(opened, ['https://example.test', 'https://link.test', 'https://navigation.test']);
});

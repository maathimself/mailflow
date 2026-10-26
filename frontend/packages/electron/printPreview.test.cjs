const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createPrintPreview } = require('./printPreview.cjs');

let nextId = 0;
class FakeWindow extends EventEmitter {
  static instances = [];
  static fromWebContents() { return null; }
  constructor(options = {}) {
    super();
    this.options = options;
    this.destroyed = false;
    this.webContents = new EventEmitter();
    Object.assign(this.webContents, {
      id: ++nextId, mainFrame: {}, getURL: () => this.url || '', getTitle: () => 'Example email',
      setWindowOpenHandler() {}, executeJavaScript: async () => true, insertCSS: async () => {},
      getPrintersAsync: async () => [{ name: 'printer-id', displayName: 'Printer', isDefault: true }],
      printToPDF: async () => new Uint8Array([37, 80, 68, 70]),
      print: (_options, callback) => callback(true, ''),
    });
    FakeWindow.instances.push(this);
  }
  async loadFile(file) { this.url = pathToFileURL(file).href; }
  show() {}
  focus() {}
  isDestroyed() { return this.destroyed; }
  close() { this.destroy(); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
}

function setup(dialogOverrides = {}) {
  const handlers = new Map();
  const service = createPrintPreview({
    BrowserWindow: FakeWindow, ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: { showErrorBox() {}, showSaveDialog: async () => ({ canceled: true }), ...dialogOverrides },
  });
  const owner = new FakeWindow(), document = new FakeWindow();
  service.register(owner.webContents, document, 'mailflow-print-1');
  const event = (window) => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  return {
    document, owner, event,
    call: (name, window, ...args) => handlers.get(`mailflow:print:${name}`)(event(window), ...args),
    handlers,
  };
}

test('only the owning main frame can open a registered preview', async () => {
  const context = setup();
  const { call, owner, handlers, event } = context;
  await assert.rejects(call('open', owner, 'missing'), /unavailable/);
  await assert.rejects(call('open', new FakeWindow(), 'mailflow-print-1'), /unavailable/);
  await assert.rejects(handlers.get('mailflow:print:open')({ ...event(owner), senderFrame: {} }, 'mailflow-print-1'), /unavailable/);
  await call('open', owner, 'mailflow-print-1');
  const preview = FakeWindow.instances.at(-1);
  assert.equal(preview.options.webPreferences.nodeIntegration, false);
  assert.equal(preview.options.webPreferences.sandbox, true);
  assert.equal((await call('load', preview)).printers[0].name, 'printer-id');
  await assert.rejects(call('load', owner), /no longer available/);
  preview.url = 'https://attacker.test';
  await assert.rejects(call('load', preview), /no longer available/);
  preview.destroy();
  assert.equal(context.document.isDestroyed(), true);
});

test('rendering is serialized and canceling Save leaves the document available', async () => {
  const { call, owner, document } = setup();
  await call('open', owner, 'mailflow-print-1');
  const preview = FakeWindow.instances.at(-1);
  let finishFirst;
  let generated = 0;
  document.webContents.printToPDF = () => {
    generated++;
    return generated === 1 ? new Promise(resolve => { finishFirst = resolve; }) : Promise.resolve(new Uint8Array([2]));
  };
  const first = call('render', preview, {}), second = call('render', preview, {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(generated, 1);
  finishFirst(new Uint8Array([1]));
  assert.deepEqual(await first, new Uint8Array([1]));
  assert.deepEqual(await second, new Uint8Array([2]));
  assert.equal(await call('save', preview, {}), false);
  assert.equal(document.isDestroyed(), false);
  preview.close();
  assert.equal(document.isDestroyed(), true);
});

test('printer errors leave preview open; success closes both windows', async () => {
  const { call, owner, document } = setup();
  await call('open', owner, 'mailflow-print-1');
  const preview = FakeWindow.instances.at(-1);
  await assert.rejects(call('submit', preview, { deviceName: 'removed-printer' }), /available printer/);
  document.webContents.print = (_options, callback) => callback(false, 'Invalid printer settings');
  await assert.rejects(call('submit', preview, { deviceName: 'printer-id' }), /Invalid printer settings/);
  assert.equal(preview.isDestroyed(), false);
  document.webContents.print = (_options, callback) => callback(false, 'Print job canceled');
  assert.equal(await call('submit', preview, {}, true), false);
  assert.equal(preview.isDestroyed(), false);
  let submitted;
  document.webContents.print = (options, callback) => { submitted = options; callback(true, ''); };
  assert.equal(await call('submit', preview, { deviceName: 'printer-id', pages: '2-3', copies: 2 }), true);
  assert.equal(submitted.silent, true);
  assert.equal(submitted.copies, 2);
  assert.deepEqual(submitted.pageRanges, [{ from: 1, to: 2 }]);
  assert.equal(preview.isDestroyed(), true);
  assert.equal(document.isDestroyed(), true);
});

test('selection mode changes the printed body and can restore the full email', async () => {
  const { call, owner, document } = setup();
  await call('open', owner, 'mailflow-print-1', { selectionHtml: '<b>Selected text</b>', accent: '#123abc' });
  const preview = FakeWindow.instances.at(-1);
  const info = await call('load', preview);
  assert.equal(info.hasSelection, true);
  assert.equal(info.accent, '#123abc');
  const changes = [];
  document.webContents.executeJavaScript = async code => {
    if (code === 'document.body.innerHTML') return '<p>Full email</p>';
    if (code.startsWith('document.body.innerHTML =')) changes.push(code);
    return true;
  };
  await call('render', preview, { selectionOnly: true });
  assert.match(changes[0], /Selected text/);
  assert.doesNotMatch(changes[0], /Full email/);
  await call('render', preview, {});
  assert.match(changes[1], /Full email/);
  preview.close();
});

test('selection-only requests without a captured selection fail clearly', async () => {
  const { call, owner } = setup();
  await call('open', owner, 'mailflow-print-1');
  const preview = FakeWindow.instances.at(-1);
  assert.equal((await call('load', preview)).hasSelection, false);
  await assert.rejects(call('render', preview, { selectionOnly: true }), /Select part of the email/);
  assert.equal(preview.isDestroyed(), false);
  preview.close();
});

test('successful PDF saving closes both windows; a failed save keeps them open', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailflow-save-test-'));
  const file = path.join(dir, 'email.pdf');
  t.after(async () => { await fs.rm(file, { force: true }); await fs.rmdir(dir); });
  let savePath = dir;
  const { call, owner, document } = setup({ showSaveDialog: async () => ({ canceled: false, filePath: savePath }) });
  await call('open', owner, 'mailflow-print-1');
  const preview = FakeWindow.instances.at(-1);
  await assert.rejects(call('save', preview, {}));
  assert.equal(preview.isDestroyed(), false);
  assert.equal(document.isDestroyed(), false);
  savePath = file;
  assert.equal(await call('save', preview, {}), true);
  assert.equal((await fs.readFile(file)).toString(), '%PDF');
  assert.equal(preview.isDestroyed(), true);
  assert.equal(document.isDestroyed(), true);
});

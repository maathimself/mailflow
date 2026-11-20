// npm run test:electron:print-preview
// Set MAILFLOW_PRINT_ASAR to a packaged resources/app.asar to test the shipped PDF.js assets.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const root = process.env.MAILFLOW_PRINT_ASAR
  ? path.join(process.env.MAILFLOW_PRINT_ASAR, 'packages', 'electron') : path.join(__dirname, '..');
const { configureWindowOpening } = require(path.join(root, 'windowOpening.cjs'));
const { createPrintPreview } = require(path.join(root, 'printPreview.cjs'));
const { printStrings, printTranslator } = require(path.join(root, 'printI18n.cjs'));
let server;
let preview;
const timeout = setTimeout(() => finish(new Error('Print preview check timed out')), 30000);
function finish(error) {
  clearTimeout(timeout);
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  server?.close();
  if (error) console.error(error);
  app.exit(error ? 1 : 0);
}
function HiddenPreview(options) {
  preview = new BrowserWindow(options);
  preview.show = () => {};
  return preview;
}
HiddenPreview.fromWebContents = BrowserWindow.fromWebContents;
async function waitReady() {
  for (let i = 0; i < 150; i++) {
    const state = await preview.webContents.executeJavaScript(`({
      error: document.querySelector('#error')?.textContent,
      ready: document.querySelector('#save')?.disabled === false,
      canvas: document.querySelector('canvas')?.width,
      pages: document.querySelector('#page-count')?.textContent
    })`);
    if (state.error) throw new Error(state.error);
    if (state.ready && state.canvas > 0) return state;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('PDF preview never became ready');
}
app.whenReady().then(async () => {
  const requests = new Set();
  session.defaultSession.webRequest.onCompleted(details => requests.add(details.url));
  const service = createPrintPreview({ BrowserWindow: HiddenPreview, ipcMain,
    dialog: { showErrorBox: (title, message) => { throw new Error(`${title}: ${message}`); } } });
  server = http.createServer((_request, response) => response.end('<!doctype html><title>MailFlow</title>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${server.address().port}`;
  const parent = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(root, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
  } });
  let printDocument;
  configureWindowOpening(parent.webContents, {
    getHost: () => host, isAllowedExternalUrl: () => false, openExternal() {},
    onPrintWindow: (child, name) => { printDocument = child; service.register(parent.webContents, child, name); },
  });
  await parent.loadURL(host);
  await parent.webContents.executeJavaScript(`(async () => {
    const win = window.open('', 'mailflow-print-1');
    win.opener = null;
    win.document.open();
    win.document.write('<!doctype html><title>Preview test</title><body><p>Full email page one</p><p style="break-before:page">Page two</p></body>');
    win.document.close();
    await window.mailflowNative.printing.preview(win.name, {
      selectionHtml: '<p>Selected part only</p>', accent: '#123abc', language: 'de'
    });
  })()`);
  assert.equal(printDocument.isVisible(), false);
  const prefs = printDocument.webContents.getLastWebPreferences();
  assert.ok(!prefs.preload);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  const t = printTranslator(printStrings('de').strings);
  assert.equal((await waitReady()).pages, t('pageCount', { count: 2 }));
  assert.equal(await preview.webContents.executeJavaScript(`document.querySelector('h1').textContent`), t('title'));
  assert.equal(await preview.webContents.executeJavaScript(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`), '#123abc');
  await preview.webContents.executeJavaScript(`document.querySelector('#selection-only').click(); true`);
  assert.equal((await waitReady()).pages, t('pageCount', { count: 1 }));
  assert.equal(await printDocument.webContents.executeJavaScript('document.body.textContent'), 'Selected part only');
  await preview.webContents.executeJavaScript(`document.querySelector('#selection-only').click(); true`);
  assert.equal((await waitReady()).pages, t('pageCount', { count: 2 }));
  assert.match(await printDocument.webContents.executeJavaScript('document.body.textContent'), /Full email page one/);
  if (process.env.MAILFLOW_PRINT_ASAR) {
    assert.ok([...requests].some(url => url.includes('app.asar/') && url.endsWith('/build/pdf.mjs')), 'PDF.js module loads from app.asar');
    // Worker requests do not appear in Electron's session.webRequest events.
    const worker = await preview.webContents.executeJavaScript(`(async () => {
      const { PDFWorker, GlobalWorkerOptions } = await import(new URL('../../../node_modules/pdfjs-dist/build/pdf.mjs', location.href).href);
      const worker = new PDFWorker();
      await worker.promise;
      const result = { threaded: worker.port instanceof Worker, source: GlobalWorkerOptions.workerSrc };
      worker.destroy();
      return result;
    })()`);
    assert.equal(worker.threaded, true, 'PDF.js uses a real worker');
    assert.ok(worker.source.includes('app.asar/') && worker.source.endsWith('/build/pdf.worker.mjs'), 'worker module loads from app.asar');
  }
  const closed = new Promise(resolve => preview.once('closed', resolve));
  preview.close();
  await closed;
  assert.equal(printDocument.isDestroyed(), true);
  console.log(`PASS: ${process.env.MAILFLOW_PRINT_ASAR ? 'packaged app.asar' : 'development'} PDF.js preview, worker, translations, selection mode, isolation, and cleanup.`);
  finish();
}).catch(finish);

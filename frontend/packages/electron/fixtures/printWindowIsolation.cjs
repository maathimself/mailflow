// Real Electron regression: npm run test:electron:print-isolation
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { configureWindowOpening } = require('../windowOpening.cjs');

let server;
const timeout = setTimeout(() => finish(new Error('Print isolation check timed out')), 20000);
function finish(error) {
  clearTimeout(timeout);
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  server?.close();
  if (error) console.error(error);
  app.exit(error ? 1 : 0);
}

app.whenReady().then(async () => {
  let imageRequests = 0;
  server = http.createServer((request, response) => {
    if (request.url === '/image.svg') {
      imageRequests++;
      response.setHeader('Content-Type', 'image/svg+xml');
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="blue"/></svg>');
      return;
    }
    response.setHeader('Content-Security-Policy', "script-src 'self'; object-src 'none'; img-src 'self' data: blob:;");
    response.end('<!doctype html><html><body>MailFlow</body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${server.address().port}`;
  const parent = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.cjs'),
      sandbox: true, nodeIntegration: false, contextIsolation: true,
    },
  });
  configureWindowOpening(parent.webContents, {
    getHost: () => host, isAllowedExternalUrl: () => false, openExternal() {},
  });
  await parent.loadURL(host);
  assert.equal(await parent.webContents.executeJavaScript('typeof window.mailflowNative'), 'object');
  const created = new Promise(resolve => parent.webContents.once('did-create-window', resolve));
  // No HTML/CSP is installed yet: the bridge must be absent even before sanitization.
  const initial = await parent.webContents.executeJavaScript(`(() => {
    window.printChild = window.open('', 'mailflow-print-1', 'show=no');
    if (!window.printChild) throw new Error('Print window was blocked');
    const bridge = typeof window.printChild.mailflowNative;
    window.printChild.opener = null;
    return { bridge, opener: window.printChild.opener };
  })()`);
  assert.equal(initial.bridge, 'undefined');
  assert.equal(initial.opener, null);
  const child = await created;
  const prefs = child.webContents.getLastWebPreferences();
  assert.ok(!prefs.preload, 'print document must not load the main preload');
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.nodeIntegrationInSubFrames, false);
  assert.equal(prefs.webviewTag, false);
  // The opener still needs same-origin DOM access for the existing print helper.
  const html = `<!doctype html><html><head><title>Print isolation</title><meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; img-src 'self' data: blob:;"></head><body><h1>Printable email</h1><img src="/image.svg"></body></html>`;
  await parent.webContents.executeJavaScript(`(() => {
    const child = window.printChild;
    child.document.open();
    child.document.write(${JSON.stringify(html)});
    child.document.close();
  })()`);
  const result = await child.webContents.executeJavaScript(`Promise.all(Array.from(document.images, img => img.complete ? Promise.resolve() : new Promise(resolve => { img.onload = resolve; img.onerror = resolve; }))).then(() => ({
    bridge: typeof window.mailflowNative, node: typeof require, opener: window.opener,
    text: document.body.textContent, imageLoaded: document.images[0].naturalWidth > 0
  }))`);
  assert.equal(result.bridge, 'undefined');
  assert.equal(result.node, 'undefined');
  assert.equal(result.opener, null);
  assert.match(result.text, /Printable email/);
  assert.equal(result.imageLoaded, true);
  assert.ok(imageRequests > 0, 'same-origin image proxy resources still load');
  const pdf = await child.webContents.printToPDF({});
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  assert.equal(await parent.webContents.executeJavaScript('typeof window.mailflowNative'), 'object');
  console.log('PASS: print window has no preload, native bridge, Node access, or opener; document writing, images, and PDF printing still work.');
  finish();
}).catch(finish);

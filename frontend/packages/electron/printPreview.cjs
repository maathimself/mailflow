const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { normalizePrintOptions, pdfOptions, printerOptions } = require('./printOptions.cjs');

function createPrintPreview({ BrowserWindow, ipcMain, dialog }) {
  const documents = new Map();
  const previews = new Map();
  const previewFile = path.join(__dirname, 'print-preview', 'index.html');
  const previewUrl = pathToFileURL(previewFile).href;

  function getPreview(event) {
    const state = previews.get(event.sender.id);
    if (!state || event.senderFrame !== event.sender.mainFrame || event.sender.getURL() !== previewUrl || state.document.isDestroyed()) {
      throw new Error('Print preview is no longer available.');
    }
    return state;
  }

  function queue(state, action) {
    const next = state.pending.then(action);
    state.pending = next.catch(() => {});
    return next;
  }

  async function prepareDocument(state, options) {
    if (options.selectionOnly && !state.selectionHtml) throw new Error('Select part of the email before opening print preview.');
    if (state.selectionOnly === options.selectionOnly) return;
    if (state.fullBody === undefined) state.fullBody = await state.document.webContents.executeJavaScript('document.body.innerHTML');
    const html = options.selectionOnly ? state.selectionHtml : state.fullBody;
    // Only change the body: the sanitized document's styles, origin, and image CSP stay active.
    await state.document.webContents.executeJavaScript(`document.body.innerHTML = ${JSON.stringify(html)}; true`);
    state.selectionOnly = options.selectionOnly;
    await state.document.webContents.executeJavaScript(`Promise.race([
      Promise.all([document.fonts.ready, ...Array.from(document.images, image => image.complete ? Promise.resolve() : new Promise(resolve => {
        image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true });
      }))]), new Promise(resolve => setTimeout(resolve, 8000))
    ]).then(() => true)`);
  }

  ipcMain.handle('mailflow:print:open', async (event, name, context = {}) => {
    const state = documents.get(`${event.sender.id}:${name}`);
    if (!state || event.senderFrame !== event.sender.mainFrame || state.document.isDestroyed()) throw new Error('Print document is unavailable.');
    if (state.preview && !state.preview.isDestroyed()) { state.preview.show(); state.preview.focus(); return; }
    state.selectionHtml = typeof context?.selectionHtml === 'string' ? context.selectionHtml : '';
    state.accent = typeof context?.accent === 'string' ? context.accent : '';
    state.accentText = typeof context?.accentText === 'string' ? context.accentText : '';
    try {
      // Wait for fonts and images, but do not let an unreachable image block printing.
      await state.document.webContents.executeJavaScript(`Promise.race([
        Promise.all([document.fonts.ready, ...Array.from(document.images, image => image.complete ? Promise.resolve() : new Promise(resolve => {
          image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true });
        }))]), new Promise(resolve => setTimeout(resolve, 8000))
      ]).then(() => true)`);
      await state.document.webContents.insertCSS('@media print { body { margin: 0 !important; } }');
      const preview = new BrowserWindow({
        parent: BrowserWindow.fromWebContents(event.sender), width: 1080, height: 800,
        minWidth: 760, minHeight: 580, show: false, title: 'Print Preview', autoHideMenuBar: true,
        backgroundColor: '#f3f4f6',
        webPreferences: { preload: path.join(__dirname, 'printPreviewPreload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      state.preview = preview;
      previews.set(preview.webContents.id, state);
      preview.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      preview.webContents.on('will-navigate', event => event.preventDefault());
      preview.webContents.on('will-redirect', event => event.preventDefault());
      const previewId = preview.webContents.id;
      preview.on('closed', () => {
        previews.delete(previewId);
        if (!state.document.isDestroyed()) state.document.destroy();
      });
      await preview.loadFile(previewFile);
      preview.show();
    } catch (error) {
      dialog.showErrorBox('Could not open print preview', error.message);
      if (state.preview && !state.preview.isDestroyed()) state.preview.destroy();
      if (!state.document.isDestroyed()) state.document.destroy();
      throw error;
    }
  });

  ipcMain.handle('mailflow:print:load', async (event) => {
    const state = getPreview(event);
    const printers = await state.document.webContents.getPrintersAsync();
    return {
      title: state.document.webContents.getTitle() || 'Email',
      hasSelection: Boolean(state.selectionHtml), accent: state.accent, accentText: state.accentText,
      printers: printers.map(({ name, displayName, isDefault }) => ({ name, displayName, isDefault })),
    };
  });
  ipcMain.handle('mailflow:print:render', (event, raw) => {
    const state = getPreview(event);
    const options = normalizePrintOptions(raw);
    return queue(state, async () => {
      await prepareDocument(state, options);
      return new Uint8Array(await state.document.webContents.printToPDF(pdfOptions(options)));
    });
  });
  ipcMain.handle('mailflow:print:save', (event, raw) => {
    const state = getPreview(event);
    const options = normalizePrintOptions(raw);
    return queue(state, async () => {
      const filename = (state.document.webContents.getTitle() || 'Email').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
      const result = await dialog.showSaveDialog(state.preview, { title: 'Save as PDF', defaultPath: `${filename}.pdf`, filters: [{ name: 'PDF document', extensions: ['pdf'] }] });
      if (result.canceled || !result.filePath) return false;
      await prepareDocument(state, options);
      const pdf = await state.document.webContents.printToPDF(pdfOptions(options, true));
      await fs.writeFile(result.filePath, pdf);
      if (!state.preview.isDestroyed()) state.preview.close();
      return true;
    });
  });
  ipcMain.handle('mailflow:print:submit', (event, raw, systemDialog) => {
    const state = getPreview(event);
    const options = normalizePrintOptions(raw);
    return queue(state, async () => {
      await prepareDocument(state, options);
      const printers = await state.document.webContents.getPrintersAsync();
      if (systemDialog !== true && !printers.some(printer => printer.name === options.deviceName)) throw new Error('Select an available printer.');
      if (process.platform === 'darwin' && options.ranges.length > 1) throw new Error('On macOS, print one page range at a time or save the selected pages as a PDF.');
      const success = await new Promise((resolve, reject) => {
        state.document.webContents.print(printerOptions(options, systemDialog === true), (success, reason) => {
          if (!success && !/cancel/i.test(reason || '')) reject(new Error(reason || 'The print job failed.'));
          else resolve(success);
        });
      });
      if (success && !state.preview.isDestroyed()) state.preview.close();
      return success;
    });
  });

  return {
    register(owner, document, name) {
      const key = `${owner.id}:${name}`;
      const state = { document, preview: null, pending: Promise.resolve(), selectionOnly: false, selectionHtml: '' };
      documents.set(key, state);
      document.on('closed', () => {
        documents.delete(key);
        if (state.preview && !state.preview.isDestroyed()) state.preview.destroy();
      });
    },
  };
}

module.exports = { createPrintPreview };

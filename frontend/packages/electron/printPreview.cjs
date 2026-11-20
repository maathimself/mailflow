const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { normalizePrintOptions, pdfOptions, printerOptions } = require('./printOptions.cjs');
const { printStrings, printTranslator } = require('./printI18n.cjs');

function createPrintPreview({ BrowserWindow, ipcMain, dialog }) {
  const documents = new Map();
  const previews = new Map();
  const previewFile = path.join(__dirname, 'print-preview', 'index.html');
  const previewUrl = pathToFileURL(previewFile).href;

  function getPreview(event) {
    const state = previews.get(event.sender.id);
    if (!state || event.senderFrame !== event.sender.mainFrame || event.sender.getURL() !== previewUrl || state.document.isDestroyed()) {
      throw new Error(state?.t('unavailable') || printTranslator()('unavailable'));
    }
    return state;
  }

  function close(state) {
    if (state.preview && !state.preview.isDestroyed()) state.preview.destroy();
    if (!state.document.isDestroyed()) state.document.destroy();
  }

  function report(state, error, fallback) {
    const message = Object.values(state.strings).includes(error.message) ? error.message : state.t(fallback);
    dialog.showErrorBox(state.t('title'), message);
    return new Error(message);
  }

  function queue(state, action, terminal = false, failure = 'previewFailed') {
    const next = state.pending.then(async () => {
      try {
        if (state.document.isDestroyed()) throw new Error(state.t('unavailable'));
        return await action();
      } catch (error) {
        close(state);
        throw report(state, error, failure);
      } finally {
        if (terminal) close(state);
      }
    });
    state.pending = next.catch(() => {});
    return next;
  }

  async function prepareDocument(state, options) {
    if (options.selectionOnly && !state.selectionHtml) throw new Error(state.t('selectFirst'));
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
    if (!state || event.senderFrame !== event.sender.mainFrame || state.document.isDestroyed()) throw new Error(printTranslator()('documentUnavailable'));
    if (state.preview && !state.preview.isDestroyed()) { state.preview.show(); state.preview.focus(); return; }
    state.selectionHtml = typeof context?.selectionHtml === 'string' ? context.selectionHtml : '';
    state.accent = typeof context?.accent === 'string' ? context.accent : '';
    state.accentText = typeof context?.accentText === 'string' ? context.accentText : '';
    Object.assign(state, printStrings(context?.language));
    state.t = printTranslator(state.strings);
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
        minWidth: 760, minHeight: 580, show: false, title: state.t('title'), autoHideMenuBar: true,
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
      close(state);
      throw report(state, error, 'loadFailed');
    }
  });

  ipcMain.handle('mailflow:print:strings', event => {
    const { strings, language } = getPreview(event);
    return { strings, language };
  });
  ipcMain.handle('mailflow:print:failed', event => {
    const state = getPreview(event);
    close(state);
    report(state, new Error(state.t('previewFailed')), 'previewFailed');
  });
  ipcMain.handle('mailflow:print:load', async (event) => {
    const state = getPreview(event);
    return queue(state, async () => {
      const printers = await state.document.webContents.getPrintersAsync();
      return {
        title: state.document.webContents.getTitle() || state.t('email'),
        hasSelection: Boolean(state.selectionHtml), accent: state.accent, accentText: state.accentText,
        printers: printers.map(({ name, displayName, isDefault }) => ({ name, displayName, isDefault })),
      };
    });
  });
  ipcMain.handle('mailflow:print:render', (event, raw) => {
    const state = getPreview(event);
    return queue(state, async () => {
      const options = normalizePrintOptions(raw, state.t);
      await prepareDocument(state, options);
      return new Uint8Array(await state.document.webContents.printToPDF(pdfOptions(options, false, state.t)));
    });
  });
  ipcMain.handle('mailflow:print:save', (event, raw) => {
    const state = getPreview(event);
    return queue(state, async () => {
      const options = normalizePrintOptions(raw, state.t);
      const filename = (state.document.webContents.getTitle() || state.t('email')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
      const result = await dialog.showSaveDialog(state.preview, { title: state.t('savePdf'), defaultPath: `${filename}.pdf`, filters: [{ name: state.t('pdfDocument'), extensions: ['pdf'] }] });
      if (result.canceled || !result.filePath) return false;
      await prepareDocument(state, options);
      const pdf = await state.document.webContents.printToPDF(pdfOptions(options, true, state.t));
      await fs.writeFile(result.filePath, pdf);
      if (!state.preview.isDestroyed()) state.preview.close();
      return true;
    }, true, 'saveFailed');
  });
  ipcMain.handle('mailflow:print:submit', (event, raw, systemDialog) => {
    const state = getPreview(event);
    return queue(state, async () => {
      const options = normalizePrintOptions(raw, state.t);
      await prepareDocument(state, options);
      const printers = await state.document.webContents.getPrintersAsync();
      if (systemDialog !== true && !printers.some(printer => printer.name === options.deviceName)) throw new Error(state.t('selectPrinter'));
      if (process.platform === 'darwin' && options.ranges.length > 1) throw new Error(state.t('macRanges'));
      const success = await new Promise((resolve, reject) => {
        state.document.webContents.print(printerOptions(options, systemDialog === true, state.t), (success, reason) => {
          if (!success && !/cancel/i.test(reason || '')) reject(new Error(state.t('printFailed')));
          else resolve(success);
        });
      });
      if (success && !state.preview.isDestroyed()) state.preview.close();
      return success;
    }, true, 'printFailed');
  });

  return {
    register(owner, document, name) {
      const key = `${owner.id}:${name}`;
      const localized = printStrings();
      const state = { document, preview: null, pending: Promise.resolve(), selectionOnly: false, selectionHtml: '', ...localized, t: printTranslator(localized.strings) };
      documents.set(key, state);
      const ownerClosed = () => close(state);
      owner.once('destroyed', ownerClosed);
      document.on('closed', () => {
        owner.removeListener('destroyed', ownerClosed);
        documents.delete(key);
        if (state.preview && !state.preview.isDestroyed()) state.preview.destroy();
      });
    },
  };
}

module.exports = { createPrintPreview };

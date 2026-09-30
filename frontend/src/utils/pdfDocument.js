// The only module that touches pdf.js. It is imported on demand, so the PDF engine (about 1.7 MB
// with its worker) is fetched the first time someone previews a PDF rather than with the app.
//
// Two settings follow from the app's Content-Security-Policy rather than from taste:
// - useWasm: false. WebAssembly needs 'wasm-unsafe-eval', which script-src does not grant, so the
//   JBIG2 and JPEG 2000 decoders that scanned documents rely on load as their pure-JavaScript
//   builds instead, from /pdfjs/wasm/ (copied there by vite.config.js).
// - No scripting. Nothing here creates pdf.js's scripting sandbox, so JavaScript inside a PDF never
//   runs, and forms and links are drawn as part of the page rather than made live.

import { printDpi, printScale } from './attachmentPreview.js';

let enginePromise = null;
// pdf.js refuses to start a document on the shared worker while an earlier one is still being torn
// down, and moving from one PDF attachment to the next (or retrying a password) does exactly that.
// Every teardown is chained here and every open waits for it.
let teardown = Promise.resolve();

function destroyTask(task) {
  teardown = teardown.then(() => task.destroy()).catch(() => {});
  return teardown;
}

function loadEngine() {
  enginePromise ??= import('pdfjs-dist').then(pdfjs => {
    // One worker for every document, created here so Vite bundles it as a .js module: the app's
    // nginx serves .js as JavaScript, but has no MIME type for the .mjs pdf.js ships.
    pdfjs.GlobalWorkerOptions.workerPort ??= new Worker(
      new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url),
      { type: 'module' },
    );
    return pdfjs;
  }).catch(err => {
    enginePromise = null;
    throw err;
  });
  return enginePromise;
}

// Opens a PDF from its bytes. Resolves { doc, pdfjs, destroy }. An encrypted PDF rejects with
// pdf.js's PasswordException until it is given the right password.
export async function openPdf(bytes, { password } = {}) {
  const pdfjs = await loadEngine();
  await teardown;
  // Versioned like the files themselves (vite.config.js), so an upgrade never reads stale ones.
  const base = `${window.location.origin}/pdfjs/${pdfjs.version}/`;
  const task = pdfjs.getDocument({
    // pdf.js moves the buffer it is given into its worker, which empties it on this side. The
    // viewer still needs the bytes for Download, so pdf.js gets a copy.
    data: bytes.slice(),
    useWasm: false,
    wasmUrl: `${base}wasm/`,
    standardFontDataUrl: `${base}standard_fonts/`,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    enableXfa: false,
    ...(password ? { password } : {}),
  });
  try {
    const doc = await task.promise;
    return { doc, pdfjs, destroy: () => destroyTask(task) };
  } catch (err) {
    await destroyTask(task);
    throw err;
  }
}

// Draws one page into `canvas`, then its text into `textContainer` as transparent, selectable
// spans laid over the drawing: that is what lets a boleto's digitable line be copied, and the
// browser's own Find reach the words on the page. Returns { done, cancel }.
export function renderPage({ doc, pdfjs }, pageNumber, { canvas, textContainer, scale, pixelRatio = 1 }) {
  let cancelled = false;
  let renderTask = null;
  let textLayer = null;
  const run = async () => {
    const page = await doc.getPage(pageNumber);
    if (cancelled) return;
    const viewport = page.getViewport({ scale });
    canvas.width = Math.max(1, Math.floor(viewport.width * pixelRatio));
    canvas.height = Math.max(1, Math.floor(viewport.height * pixelRatio));
    renderTask = page.render({
      canvas,
      viewport,
      transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
    });
    await renderTask.promise;
    if (cancelled || !textContainer) return;
    textContainer.replaceChildren();
    textContainer.style.setProperty('--total-scale-factor', String(viewport.scale));
    textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textContainer, viewport });
    await textLayer.render();
  };
  const done = run().catch(err => {
    if (cancelled || err?.name === 'RenderingCancelledException') return;
    throw err;
  });
  return {
    done,
    cancel() {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    },
  };
}

// Renders every page for printing and returns one image URL per page, in order. The caller
// revokes the URLs once printing is over.
export async function renderPagesForPrint({ doc }, { onProgress, isCancelled } = {}) {
  const urls = [];
  const dpi = printDpi(doc.numPages);
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      if (isCancelled?.()) break;
      const page = await doc.getPage(n);
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: printScale(natural.width, natural.height, dpi) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      await page.render({ canvas, viewport, intent: 'print' }).promise;
      const blob = await new Promise((resolve, reject) => canvas.toBlob(
        b => (b ? resolve(b) : reject(new Error('Could not encode the page for printing'))), 'image/png'));
      urls.push(URL.createObjectURL(blob));
      // Release the 300 dpi bitmap now rather than whenever the collector gets to it.
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();
      onProgress?.(n, doc.numPages);
    }
    return urls;
  } catch (err) {
    urls.forEach(url => URL.revokeObjectURL(url));
    throw err;
  }
}

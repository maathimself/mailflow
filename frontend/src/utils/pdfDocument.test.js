// Run with: node --test src/utils/pdfDocument.test.js
//
// pdf.js shares one worker between documents and refuses to start a document on it while an
// earlier one is still being torn down ("PDFWorker.create - the worker is being destroyed").
// Closing a PDF and opening the next straight away is exactly what the viewer does when it moves
// between two PDF attachments, and when a password attempt fails and the user tries again. The
// stand-in below reproduces that rule, so these tests fail if openPdf stops waiting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/pdfjs-dist/build/pdf.mjs')) {
      return { format: 'module', shortCircuit: true, source: `
        let tearingDown = 0;
        export const version = '9.9.9';
        export const GlobalWorkerOptions = { workerPort: null };
        export function getDocument(params) {
          globalThis.__lastParams = params;
          const { password } = params;
          if (tearingDown) throw new Error('PDFWorker.create - the worker is being destroyed.');
          const promise = password === 'segredo'
            ? Promise.resolve({ numPages: 1 })
            : Promise.reject(Object.assign(new Error('Password required'), { name: 'PasswordException', code: password ? 2 : 1 }));
          promise.catch(() => {});
          return {
            promise,
            async destroy() {
              tearingDown++;
              await new Promise(r => setTimeout(r, 20));
              tearingDown--;
            },
          };
        }
      ` };
    }
    return nextLoad(url, context);
  },
});

globalThis.window = { location: { origin: 'https://mail.test' } };
globalThis.Worker = class { constructor() {} };

const { openPdf } = await import('./pdfDocument.js');
const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

test('a wrong password can be retried straight away, and the right one opens', async () => {
  await assert.rejects(openPdf(bytes), { name: 'PasswordException', code: 1 });
  await assert.rejects(openPdf(bytes, { password: 'errada' }), { name: 'PasswordException', code: 2 });
  const opened = await openPdf(bytes, { password: 'segredo' });
  assert.equal(opened.doc.numPages, 1);
  await opened.destroy();
});

test('closing a PDF and opening the next without waiting still works', async () => {
  const first = await openPdf(bytes, { password: 'segredo' });
  first.destroy(); // not awaited, as a component unmounting does not wait
  const second = await openPdf(bytes, { password: 'segredo' });
  assert.equal(second.doc.numPages, 1);
  await second.destroy();
});

test('fonts, decoders and CJK character maps are read from the path of this pdf.js version', async () => {
  const opened = await openPdf(bytes, { password: 'segredo' });
  const params = globalThis.__lastParams;
  assert.equal(params.standardFontDataUrl, 'https://mail.test/pdfjs/9.9.9/standard_fonts/');
  assert.equal(params.wasmUrl, 'https://mail.test/pdfjs/9.9.9/wasm/');
  assert.equal(params.cMapUrl, 'https://mail.test/pdfjs/9.9.9/cmaps/', 'without it a PDF with a non-embedded CJK font shows no text');
  assert.equal(params.cMapPacked, true);
  await opened.destroy();
});

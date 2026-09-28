// Run with: node --test src/utils/attachmentPreview.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  previewKind,
  sniffPreview,
  nextZoom,
  fitScale,
  printScale,
  canvasPixelRatio,
  printDocumentHtml,
  passwordReason,
} from './attachmentPreview.js';

const bytes = (...values) => new Uint8Array(values.flat());
const ascii = s => [...s].map(c => c.charCodeAt(0));

describe('previewKind', () => {
  it('offers the viewer for PDFs and raster images', () => {
    assert.equal(previewKind({ filename: 'Boleto NF 82.pdf', type: 'application/pdf' }), 'pdf');
    assert.equal(previewKind({ filename: 'foto.JPG', type: 'image/jpeg' }), 'image');
    assert.equal(previewKind({ filename: 'print.png', type: 'image/png' }), 'image');
    assert.equal(previewKind({ filename: 'scan.webp', type: 'image/webp' }), 'image');
  });

  it('trusts the extension over a generic declared type', () => {
    // Outlook and many scanners send PDFs as application/octet-stream.
    assert.equal(previewKind({ filename: 'nota.pdf', type: 'application/octet-stream' }), 'pdf');
  });

  it('falls back to the declared type only when the name has no extension', () => {
    assert.equal(previewKind({ filename: 'documento', type: 'application/pdf' }), 'pdf');
    assert.equal(previewKind({ filename: 'imagem', type: 'image/png' }), 'image');
    assert.equal(previewKind({ filename: 'arquivo', type: 'application/octet-stream' }), null);
  });

  it('never previews what the risk classifier flags', () => {
    assert.equal(previewKind({ filename: 'invoice.pdf.exe', type: 'application/pdf' }), null);
    assert.equal(previewKind({ filename: 'logo.svg', type: 'image/svg+xml' }), null);
    assert.equal(previewKind({ filename: 'login.html', type: 'text/html' }), null);
    // A picture name with an HTML type is a credential-harvesting page, not a photo.
    assert.equal(previewKind({ filename: 'photo.jpg', type: 'text/html' }), null);
  });

  it('leaves other documents and archives as downloads', () => {
    assert.equal(previewKind({ filename: 'planilha.xlsx', type: 'application/vnd.ms-excel' }), null);
    assert.equal(previewKind({ filename: 'contrato.docx', type: 'application/msword' }), null);
    assert.equal(previewKind({ filename: 'fotos.zip', type: 'application/zip' }), null);
    assert.equal(previewKind({ filename: 'IMG_0001.HEIC', type: 'image/heic' }), null);
    assert.equal(previewKind(null), null);
  });
});

describe('sniffPreview', () => {
  it('recognizes a PDF header, including one after leading junk', () => {
    assert.deepEqual(sniffPreview(bytes(ascii('%PDF-1.7\n'))), { kind: 'pdf', type: 'application/pdf' });
    assert.deepEqual(sniffPreview(bytes(new Array(300).fill(0x20), ascii('%PDF-1.4'))),
      { kind: 'pdf', type: 'application/pdf' });
  });

  it('gives up on a PDF header buried past the first kilobyte', () => {
    assert.equal(sniffPreview(bytes(new Array(2000).fill(0x20), ascii('%PDF-1.4'))), null);
  });

  it('recognizes the raster formats by their signatures', () => {
    assert.equal(sniffPreview(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)).type, 'image/png');
    assert.equal(sniffPreview(bytes(0xff, 0xd8, 0xff, 0xe0)).type, 'image/jpeg');
    assert.equal(sniffPreview(bytes(ascii('GIF89a'))).type, 'image/gif');
    assert.equal(sniffPreview(bytes(ascii('RIFF'), 0, 0, 0, 0, ascii('WEBPVP8 '))).type, 'image/webp');
    assert.equal(sniffPreview(bytes(ascii('BM'), 0, 0)).type, 'image/bmp');
  });

  it('rejects bytes that are not a previewable format, whatever the name said', () => {
    assert.equal(sniffPreview(bytes(ascii('<!DOCTYPE html><script>'))), null);
    assert.equal(sniffPreview(bytes(ascii('<svg xmlns="http://www.w3.org/2000/svg">'))), null);
    assert.equal(sniffPreview(bytes(ascii('PK'), 3, 4)), null);
    assert.equal(sniffPreview(bytes()), null);
    assert.equal(sniffPreview(undefined), null);
  });

  it('accepts an ArrayBuffer as well as a Uint8Array', () => {
    assert.equal(sniffPreview(bytes(0xff, 0xd8, 0xff).buffer).kind, 'image');
  });
});

describe('zoom and scale', () => {
  it('steps zoom through the presets and stops at either end', () => {
    assert.equal(nextZoom(1, 1), 1.25);
    assert.equal(nextZoom(1, -1), 0.75);
    assert.equal(nextZoom(3, 1), 3);
    assert.equal(nextZoom(0.5, -1), 0.5);
  });

  it('fits the widest page to the available width, up to a ceiling', () => {
    assert.equal(fitScale(595, 595), 1);
    assert.equal(fitScale(297.5, 595), 0.5);
    assert.equal(fitScale(4000, 595), 1.6);
    assert.equal(fitScale(0, 595), 1);
  });

  it('prints at 300 dpi but never past the canvas pixel ceiling', () => {
    assert.equal(printScale(595, 842), 300 / 72);
    const huge = printScale(2384, 3370); // A0
    assert.ok(2384 * huge * 3370 * huge <= 16_000_000 + 1);
  });

  it('caps the on-screen pixel ratio the same way', () => {
    assert.equal(canvasPixelRatio(800, 1100, 2), 2);
    const capped = canvasPixelRatio(3000, 4200, 3);
    assert.ok(3000 * capped * 4200 * capped <= 16_000_000 + 1);
    assert.equal(canvasPixelRatio(800, 1100, 0), 1);
  });
});

describe('passwordReason', () => {
  const passwordError = code => Object.assign(new Error('pw'), { name: 'PasswordException', code });

  it('tells a missing password from a wrong one', () => {
    assert.equal(passwordReason(passwordError(1)), 'required');
    assert.equal(passwordReason(passwordError(2)), 'incorrect');
  });

  it('ignores every other failure', () => {
    assert.equal(passwordReason(new Error('Invalid PDF structure')), null);
    assert.equal(passwordReason(Object.assign(new Error('x'), { name: 'InvalidPDFException', code: 2 })), null);
    assert.equal(passwordReason(undefined), null);
  });
});

describe('printDocumentHtml', () => {
  it('puts one image per page and escapes the title and URLs', () => {
    const html = printDocumentHtml('Boleto <2431> & "NF"', ['blob:https://mail.test/a', 'blob:https://mail.test/b"x']);
    assert.match(html, /<title>Boleto &lt;2431&gt; &amp; &quot;NF&quot;<\/title>/);
    assert.equal((html.match(/<div class="page">/g) || []).length, 2);
    assert.ok(html.includes('src="blob:https://mail.test/b&quot;x"'));
  });

  it('carries no script of its own', () => {
    assert.doesNotMatch(printDocumentHtml('x', ['blob:a']), /<script|on\w+=/i);
  });
});

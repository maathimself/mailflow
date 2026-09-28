// Which attachments open in MailFlow's own viewer instead of downloading, and the byte check that
// decides what the viewer shows once the file arrives.
//
// Only PDFs and common raster images qualify, and only when the risk classifier rates the file
// 'ok': an HTML or SVG "invoice" stays a download behind its warning. The file name only decides
// whether the viewer is offered; the bytes decide what is rendered, so a renamed file cannot get a
// renderer it was not written for. Images are shown with <img>, which never runs script, and PDFs
// are drawn by pdf.js onto a canvas, never handed to a browser plugin.

import { classifyAttachmentRisk } from './attachmentRisk.js';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'jpe', 'jfif', 'gif', 'webp', 'bmp']);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/pjpeg', 'image/gif', 'image/webp', 'image/bmp']);

// 'pdf', 'image' or null. A name without an extension falls back to the declared MIME type.
export function previewKind(att) {
  const risk = classifyAttachmentRisk(att?.filename, att?.type);
  if (risk.level !== 'ok') return null;
  const type = String(att?.type || '').toLowerCase().split(';')[0].trim();
  if (risk.ext === 'pdf' || (!risk.ext && type === 'application/pdf')) return 'pdf';
  if (IMAGE_EXTENSIONS.has(risk.ext) || (!risk.ext && IMAGE_TYPES.has(type))) return 'image';
  return null;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
// PDF readers accept up to 1 KB of junk before the header, and real mail carries such files.
const PDF_HEADER_WINDOW = 1024;

// { kind, type } for bytes the viewer can render, else null.
export function sniffPreview(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input ?? 0);
  const at = (offset, signature) => signature.every((b, i) => bytes[offset + i] === b);
  const lastPdfOffset = Math.min(bytes.length - PDF_MAGIC.length, PDF_HEADER_WINDOW);
  for (let i = 0; i <= lastPdfOffset; i++) {
    if (at(i, PDF_MAGIC)) return { kind: 'pdf', type: 'application/pdf' };
  }
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', type: 'image/png' };
  if (at(0, [0xff, 0xd8, 0xff])) return { kind: 'image', type: 'image/jpeg' };
  if (at(0, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return { kind: 'image', type: 'image/gif' };
  }
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return { kind: 'image', type: 'image/webp' };
  if (at(0, [0x42, 0x4d])) return { kind: 'image', type: 'image/bmp' };
  return null;
}

// Zoom steps, as multiples of the fitted size.
export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

export function nextZoom(current, direction) {
  if (direction > 0) return ZOOM_STEPS.find(z => z > current + 1e-9) ?? current;
  return [...ZOOM_STEPS].reverse().find(z => z < current - 1e-9) ?? current;
}

// A PDF page rendered at its natural size is 1 CSS px per point, which is small next to a wide
// reading area and huge on a phone, so pages are fitted to the available width. The ceiling keeps
// a portrait page on a wide monitor from growing into a poster.
const MAX_FIT_SCALE = 1.6;

export function fitScale(availableWidth, widestPagePoints) {
  if (!(availableWidth > 0) || !(widestPagePoints > 0)) return 1;
  return Math.min(availableWidth / widestPagePoints, MAX_FIT_SCALE);
}

// Printing draws each page at 300 dpi, enough for a boleto's barcode to scan off paper, but never
// past what a browser will allocate for one canvas (iOS stops at 16.7 megapixels).
const PRINT_DPI = 300;
const MAX_CANVAS_PIXELS = 16_000_000;

export function printScale(widthPoints, heightPoints) {
  const dpiScale = PRINT_DPI / 72;
  if (!(widthPoints > 0) || !(heightPoints > 0)) return dpiScale;
  return Math.min(dpiScale, Math.sqrt(MAX_CANVAS_PIXELS / (widthPoints * heightPoints)));
}

// The same ceiling for the on-screen canvas, where zoom times the display's pixel ratio adds up.
export function canvasPixelRatio(cssWidth, cssHeight, devicePixelRatio) {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  if (!(cssWidth > 0) || !(cssHeight > 0)) return ratio;
  return Math.min(ratio, Math.sqrt(MAX_CANVAS_PIXELS / (cssWidth * cssHeight)));
}

const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);

// The document printed from a hidden frame: one image per sheet, scaled to fit it whatever the
// paper size, so an A4 page on Letter paper shrinks slightly rather than spilling onto a second
// sheet. It carries no script; the frame is printed from outside.
export function printDocumentHtml(title, imageUrls) {
  const pages = imageUrls.map(url => `<div class="page"><img src="${escapeHtml(url)}" alt=""></div>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
@page { size: auto; margin: 5mm; }
html, body { margin: 0; padding: 0; background: #fff; }
.page { height: 100vh; display: flex; align-items: center; justify-content: center; overflow: hidden; break-after: page; }
.page:last-child { break-after: auto; }
img { display: block; max-width: 100%; max-height: 100%; }
</style></head><body>${pages}</body></html>`;
}

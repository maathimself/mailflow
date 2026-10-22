import { randomBytes } from 'crypto';

const IMG_TAG_RE = /<img\b([^>]*)>/gi;
const DATA_SRC_RE = /\ssrc=["'](data:image\/([^;]+);base64,([^"']+))["']/i;

export function mimeToExtension(mimeSubtype) {
  const sub = (mimeSubtype || 'png').toLowerCase();
  if (sub === 'jpeg') return 'jpg';
  if (sub === 'svg+xml') return 'svg';
  return sub.replace(/[^a-z0-9+.-]/g, '') || 'png';
}

// Image types some mailers write for the standard ones (#640). A data: URI is built from the
// standard type, which browsers and the sanitizer's data: background allowlist know.
const IMAGE_TYPE_ALIASES = new Map([
  ['image/jpg', 'image/jpeg'],
  ['image/jpe', 'image/jpeg'],
  ['image/pjpeg', 'image/jpeg'],
  ['image/x-citrix-jpeg', 'image/jpeg'],
  ['image/x-png', 'image/png'],
  ['image/x-citrix-png', 'image/png'],
  ['image/x-ms-bmp', 'image/bmp'],
  ['image/x-bmp', 'image/bmp'],
  ['image/x-windows-bmp', 'image/bmp'],
]);

export const standardImageType = (type) => {
  const lower = String(type || '').toLowerCase();
  return IMAGE_TYPE_ALIASES.get(lower) || lower;
};

// Raster image file extensions, and the type a file named so is shown as.
const RASTER_IMAGE_EXTENSIONS = new Map([
  ['png', 'image/png'],
  ['gif', 'image/gif'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['jpe', 'image/jpeg'],
  ['jfif', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['bmp', 'image/bmp'],
  ['avif', 'image/avif'],
]);

// The image type a file name gives (photo.JPG: image/jpeg), or '' when it is not a raster image's.
export function rasterImageTypeOfName(filename) {
  const name = String(filename || '').trim();
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : RASTER_IMAGE_EXTENSIONS.get(name.slice(dot + 1).toLowerCase()) || '';
}

// The raster image the first bytes of a file are (its magic number), or ''. A part sent as
// application/octet-stream and named header.png is shown as an image only when it is one (#640):
// an HTML page, an SVG or a PDF named so stays a file.
export function sniffImageType(bytes) {
  if (!bytes || bytes.length < 3) return '';
  const head = bytes.toString('latin1', 0, 12);
  if (head.startsWith('\x89PNG\r\n\x1a\n')) return 'image/png';
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  if (head.startsWith('BM')) return 'image/bmp';
  if (head.slice(4, 8) === 'ftyp' && (head.slice(8, 12) === 'avif' || head.slice(8, 12) === 'avis')) return 'image/avif';
  return '';
}

// Convert inline data: images to MIME CID attachments so recipients can display them.
// Most email clients (Gmail, Outlook, Apple Mail) ignore or strip data: URIs in HTML.
export function embedInlineDataImages(html) {
  if (!html) return { html, attachments: [] };

  const attachments = [];
  let index = 0;

  const rewritten = html.replace(IMG_TAG_RE, (match, attrs) => {
    const srcMatch = attrs.match(DATA_SRC_RE);
    if (!srcMatch) return match;

    const [, , mimeSubtype, b64] = srcMatch;
    const cid = `img-${randomBytes(8).toString('hex')}-${index}@mailflow`;

    attachments.push({
      filename: `image-${index}.${mimeToExtension(mimeSubtype)}`,
      content: Buffer.from(b64, 'base64'),
      cid,
      contentDisposition: 'inline',
      contentType: `image/${mimeSubtype}`,
    });
    index += 1;

    const newAttrs = attrs.replace(DATA_SRC_RE, ` src="cid:${cid}"`);
    return `<img${newAttrs}>`;
  });

  return { html: rewritten, attachments };
}
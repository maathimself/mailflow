import { randomBytes } from 'crypto';

const IMG_TAG_RE = /<img\b([^>]*)>/gi;
const DATA_SRC_RE = /\ssrc=["'](data:image\/([^;]+);base64,([^"']+))["']/i;

function mimeToExtension(mimeSubtype) {
  const sub = (mimeSubtype || 'png').toLowerCase();
  if (sub === 'jpeg') return 'jpg';
  if (sub === 'svg+xml') return 'svg';
  return sub.replace(/[^a-z0-9+.-]/g, '') || 'png';
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
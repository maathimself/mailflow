// Inline images (cid: parts) travel inside the body as data: URIs: an email with a 3 MB photo in
// it sent 4 MB of base64 on every open, which compression barely touches. As the body route serves
// it, each large one is fitted like an image through the proxy (services/imageShrink.js, to twice a
// usual email column), and the result kept in the image cache, so the work is done once.
//
// The stored body keeps the originals: a forward asks for them (?original=1), so a recipient gets
// the photo as it was sent, not the reader's fitted copy.
import { createHash } from 'node:crypto';
import { imageCache } from './imageCache.js';
import { shrinkImage } from './imageShrink.js';

export const INLINE_FIT_ABOVE_BYTES = 256 * 1024;
const DATA_IMAGE = /data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})/g;

// { html, count }: `html` with its large inline images fitted, and how many were.
export async function fitInlineImages(html, userId, { cache = imageCache, shrink = shrinkImage } = {}) {
  if (!html || html.length < INLINE_FIT_ABOVE_BYTES) return { html, count: 0 };
  const found = new Map();
  for (const m of html.matchAll(DATA_IMAGE)) {
    if (!found.has(m[0]) && (m[2].length * 3) / 4 >= INLINE_FIT_ABOVE_BYTES) found.set(m[0], m);
  }
  if (!found.size) return { html, count: 0 };
  const fitted = new Map();
  for (const [uri, [, type, b64]] of found) {
    const key = createHash('sha256').update(`${userId}\0inline\0`).update(b64).digest('hex');
    try {
      const original = { bytes: Buffer.from(b64, 'base64'), type };
      const out = await cache.load(key, () => shrink(original));
      if (out.bytes.length < original.bytes.length) fitted.set(uri, `data:${out.type};base64,${out.bytes.toString('base64')}`);
    } catch {
      // Served as it is.
    }
  }
  if (!fitted.size) return { html, count: 0 };
  return { html: html.replace(DATA_IMAGE, (uri) => fitted.get(uri) ?? uri), count: fitted.size };
}

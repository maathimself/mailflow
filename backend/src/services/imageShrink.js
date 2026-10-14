// Oversized images through the image proxy (services/imageProxy.js): an email's photo can be
// several megabytes at thousands of pixels wide, shown at a few hundred. Proxied, every byte
// crosses the MailFlow server's own connection, which on a home server is often its upload, so a
// 6 MB photo took seconds. An image above SHRINK_ABOVE_BYTES is scaled to at most MAX_WIDTH px
// wide (sharp on a high-density screen) and re-encoded as WebP, which also drops its metadata and
// means the browser decodes MailFlow's encoding, not the sender's file.
//
// Everything else passes through byte for byte: smaller images, GIFs, animated images (their
// frames would be lost), and anything sharp cannot read or does not make smaller.
import sharp from 'sharp';
import { createUserLimiter } from './imageProxy.js';

export const SHRINK_ABOVE_BYTES = 500 * 1024;
export const MAX_WIDTH = 1600;
export const QUALITY = 80;
// Fully decoded, an image needs about 4 bytes a pixel: 40 megapixels is 160 MB, and larger PNG and
// AVIF images pass through. JPEG and WebP are decoded straight at a fraction of their size
// (shrink-on-load), so a 10,000 px wide photo, which is what senders really send, stays small in
// memory; they may be up to 120 megapixels.
export const MAX_INPUT_PIXELS = 40_000_000;
export const MAX_SHRINK_ON_LOAD_PIXELS = 120_000_000;
const SHRINK_ON_LOAD = new Set(['image/jpeg', 'image/webp']);
const SHRINKABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

// libvips caches decoded images and runs several threads per image by default; on a small server
// shared by several users, keep neither, and resize at most two images at a time.
sharp.cache(false);
sharp.concurrency(1);
const resizeSlots = createUserLimiter(2);

// An animated PNG: libvips reads its first frame only. Its acTL chunk comes before the image data.
function isAnimatedPng(bytes) {
  const idat = bytes.indexOf('IDAT', 8, 'latin1');
  const actl = bytes.indexOf('acTL', 8, 'latin1');
  return actl !== -1 && (idat === -1 || actl < idat);
}

// { bytes, type } as fetched, or smaller as WebP.
export async function shrinkImage(image, { sharpImpl = sharp } = {}) {
  const { bytes, type } = image;
  if (bytes.length <= SHRINK_ABOVE_BYTES || !SHRINKABLE.has(type)) return image;
  if (type === 'image/png' && isAnimatedPng(bytes)) return image;
  try {
    return await resizeSlots('shrink', async () => {
      const input = sharpImpl(bytes, {
        limitInputPixels: SHRINK_ON_LOAD.has(type) ? MAX_SHRINK_ON_LOAD_PIXELS : MAX_INPUT_PIXELS,
      });
      const meta = await input.metadata();
      if ((meta.pages ?? 1) > 1) return image;
      const out = await input
        .rotate() // apply the EXIF orientation before the metadata is dropped
        .resize({ width: MAX_WIDTH, withoutEnlargement: true })
        .webp({ quality: QUALITY })
        .toBuffer();
      return out.length < bytes.length * 0.9 ? { bytes: out, type: 'image/webp' } : image;
    });
  } catch {
    return image;
  }
}

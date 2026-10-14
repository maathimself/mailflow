// Images through the image proxy (services/imageProxy.js), fitted to how the email shows them. An
// email's photo can be several megabytes at thousands of pixels wide, shown at a few hundred, and a
// product shot 600 px wide is often shown at 180. Proxied, every byte crosses the MailFlow server's
// own connection, often a home server's upload, and then the reader's, often a phone's. So an
// image wider than twice the width the email gives it (the proxy URL carries that width; without
// one, twice a usual 600 px email column) is scaled to that, and one that is merely heavy is
// re-encoded, both as WebP, which also drops their metadata and means the browser decodes
// MailFlow's encoding, not the sender's file. A newsletter measured at 1.28 MB came to 455 KB.
//
// Everything else passes through byte for byte: small images already their shown size, GIFs,
// animated images (their frames would be lost), and anything sharp cannot read or does not make
// smaller. The result is kept by the image cache (services/imageCache.js), so this runs once.
import sharp from 'sharp';
import os from 'node:os';
import { createUserLimiter } from './imageProxy.js';

// Re-encoded when this heavy even if not wider than shown.
export const SHRINK_ABOVE_BYTES = 200 * 1024;
// Never wider than this, whatever width the email gives.
export const MAX_WIDTH = 1600;
// When the email gives no width: twice a usual 600-640 px email column.
export const DEFAULT_WIDTH = 1280;
export const MIN_WIDTH = 64;
export const QUALITY = 80;

// The width to fit an image shown `shown` px wide to: twice that, for high-density screens.
export function targetWidth(shown) {
  const n = Number(shown);
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.ceil(n * 2))) : DEFAULT_WIDTH;
}
// Fully decoded, an image needs about 4 bytes a pixel: 40 megapixels is 160 MB, and larger PNG and
// AVIF images pass through. JPEG and WebP are decoded straight at a fraction of their size
// (shrink-on-load), so a 10,000 px wide photo, which is what senders really send, stays small in
// memory; they may be up to 120 megapixels.
export const MAX_INPUT_PIXELS = 40_000_000;
export const MAX_SHRINK_ON_LOAD_PIXELS = 120_000_000;
const SHRINK_ON_LOAD = new Set(['image/jpeg', 'image/webp']);
const SHRINKABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

// libvips caches decoded images and runs several threads per image by default; on a small server
// shared by several users, keep neither. Images are resized a few at a time: now that most images
// are fitted, not only the heaviest, two at a time held a newsletter's first view back.
sharp.cache(false);
sharp.concurrency(1);
const resizeSlots = createUserLimiter(Math.min(4, Math.max(2, (os.availableParallelism?.() ?? 2) - 1)));

// An animated PNG: libvips reads its first frame only. Its acTL chunk comes before the image data.
function isAnimatedPng(bytes) {
  const idat = bytes.indexOf('IDAT', 8, 'latin1');
  const actl = bytes.indexOf('acTL', 8, 'latin1');
  return actl !== -1 && (idat === -1 || actl < idat);
}

// { bytes, type } as fetched, or fitted to `width` (the width the email shows it at) as WebP.
export async function shrinkImage(image, { width = null, sharpImpl = sharp } = {}) {
  const { bytes, type } = image;
  if (!SHRINKABLE.has(type)) return image;
  if (type === 'image/png' && isAnimatedPng(bytes)) return image;
  const target = targetWidth(width);
  const options = { limitInputPixels: SHRINK_ON_LOAD.has(type) ? MAX_SHRINK_ON_LOAD_PIXELS : MAX_INPUT_PIXELS };
  try {
    // The header alone: cheap, and outside the resize slots.
    const meta = await sharpImpl(bytes, options).metadata();
    if ((meta.pages ?? 1) > 1) return image;
    const upright = (meta.orientation ?? 1) >= 5 ? meta.height : meta.width;
    if (!(upright > target * 1.25) && bytes.length <= SHRINK_ABOVE_BYTES) return image;
    return await resizeSlots('shrink', async () => {
      const out = await sharpImpl(bytes, options)
        .rotate() // apply the EXIF orientation before the metadata is dropped
        .resize({ width: target, withoutEnlargement: true })
        .webp({ quality: QUALITY })
        .toBuffer();
      return out.length < bytes.length * 0.9 ? { bytes: out, type: 'image/webp' } : image;
    });
  } catch {
    return image;
  }
}

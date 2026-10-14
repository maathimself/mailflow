// Images in an email body shown dark (#228).
//
// Images are never recolored. Two kinds still need help on a dark background:
//   - MailFlow's own placeholders for blocked remote images (backend emailSanitizer.js
//     blockRemoteImages): light gray boxes that would glare. Drawn dark whenever the body is.
//   - Images drawn dark on a transparent background (a logo's black lettering, a dark icon) would
//     vanish into the dark background. Such an image gets a light backing, as Apple Mail and
//     Gmail give them. Only when MailFlow recolored the email: a sender's own dark design handles
//     its own images.
// Telling the second kind needs the image's pixels, which a page can only read for images from its
// own origin: inline images (cid:, delivered as data: URIs) qualify; remote ones do not, until
// MailFlow serves them itself.
//
// Every change is an inline !important style whose old value is kept, so it is undone exactly.

// The exact placeholder blockRemoteImages writes.
import { isDeferredImage } from './frameLazyImages.js';

const PLACEHOLDER = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="\d+"><rect width="100%" height="100%" fill="#e8e8e8"\/><\/svg>$/;
const SVG_PREFIX = 'data:image/svg+xml,';

export function isBlockedPlaceholder(img) {
  const src = img.getAttribute('src') || '';
  if (!src.startsWith(SVG_PREFIX)) return false;
  try {
    return PLACEHOLDER.test(decodeURIComponent(src.slice(SVG_PREFIX.length)));
  } catch {
    return false;
  }
}

// Whether this page may read the image's pixels: data: and blob: images, and its own origin's.
export function readablePixels(img) {
  const src = img.currentSrc || img.getAttribute('src') || '';
  if (/^(data|blob):/i.test(src)) return true;
  try {
    const origin = globalThis.location?.origin;
    return Boolean(origin) && origin !== 'null' && new URL(src, img.ownerDocument.baseURI).origin === origin;
  } catch {
    return false;
  }
}

const SAMPLE = 48;
// Relative luminance below which a pixel is hard to see on a dark theme background (under about
// 2.7:1 against the default dark background).
const DARK_PIXEL = 0.1;

// Of a small copy of the image: the share of pixels that are see-through, and of the rest, the
// share too dark to see on a dark background. Null when it cannot be read.
export function imageStats(img) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return null;
  const scale = Math.min(1, SAMPLE / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = (globalThis.document ?? img.ownerDocument).createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  let data;
  try {
    g.drawImage(img, 0, 0, cw, ch);
    data = g.getImageData(0, 0, cw, ch).data;
  } catch {
    // A canvas the browser considers tainted, or an image it cannot draw.
    return null;
  }
  const lin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  let transparent = 0;
  let opaque = 0;
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) { transparent += 1; continue; }
    opaque += 1;
    if (0.2126 * lin(data[i]) + 0.7152 * lin(data[i + 1]) + 0.0722 * lin(data[i + 2]) < DARK_PIXEL) dark += 1;
  }
  const total = transparent + opaque;
  return { transparent: transparent / total, dark: opaque ? dark / opaque : 0 };
}

// A see-through image whose visible part is largely dark: it would vanish on a dark background.
export const needsBacking = (stats) => Boolean(stats) && stats.transparent >= 0.1 && stats.dark >= 0.3;

// Images that need a backing are logos and icons. Reading a big photo's pixels decodes the whole of
// it on the main thread first (36 ms for 2400x3600 in Chromium), for an answer that is all but
// always no, so images over a megapixel are not read.
export const MAX_SAMPLED_PIXELS = 1_000_000;
const worthSampling = (img) => img.naturalWidth * img.naturalHeight <= MAX_SAMPLED_PIXELS;

export const BACKING = 'rgb(232, 232, 240)';

// Makes the changes in `doc`; with `backings`, also backs images that need it, including any that
// finish loading later. Returns how to undo it all, and counts of what it did so far.
export function darkenImages(doc, { backings = false } = {}) {
  const saved = [];
  const set = (el, prop, value) => {
    saved.push([el, prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
    el.style.setProperty(prop, value, 'important');
  };
  const counts = { placeholders: 0, backed: 0, waiting: 0 };
  let active = true;
  const listeners = [];
  const back = (img) => {
    if (!active || !worthSampling(img) || !needsBacking(imageStats(img))) return;
    set(img, 'background-color', BACKING);
    counts.backed += 1;
  };
  for (const img of doc.querySelectorAll('img')) {
    if (isBlockedPlaceholder(img)) {
      // #e8e8e8 inverted is #171717, a gray just above the dark themes' backgrounds.
      set(img, 'filter', 'invert(1)');
      counts.placeholders += 1;
      continue;
    }
    if (!backings || !readablePixels(img)) continue;
    // A held-back image (utils/frameLazyImages.js) counts as complete with nothing loaded: wait.
    if (img.complete && !isDeferredImage(img)) {
      back(img);
    } else {
      const onLoad = () => back(img);
      img.addEventListener('load', onLoad, { once: true });
      listeners.push([img, onLoad]);
      counts.waiting += 1;
    }
  }
  const undo = () => {
    active = false;
    for (const [img, onLoad] of listeners) img.removeEventListener('load', onLoad);
    for (let i = saved.length - 1; i >= 0; i -= 1) {
      const [el, prop, value, priority] = saved[i];
      if (value) el.style.setProperty(prop, value, priority);
      else el.style.removeProperty(prop);
    }
  };
  return { undo, counts };
}

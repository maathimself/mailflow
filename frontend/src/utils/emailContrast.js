// How readable the text of a rendered email is (#228): the contrast of each piece of visible text
// against what is actually painted behind it.
//
// Used by the dark-mode audit harness (scripts/dark-audit) to score each way of showing a body, and
// meant for dark email bodies to check their own result before showing it. Runs on a laid-out
// document (the frame's), because only the browser knows an element's final colors after the
// email's CSS, inheritance and MailFlow's own styles have all applied.
//
// Text a sender hides on purpose is not counted: newsletters carry preview text that is zero-sized,
// clipped away, transparent or pushed off screen. Text drawn over a background image (or a
// gradient) is counted separately, as its background is not a single color.

// A computed color: always rgb() or rgba() in the browsers MailFlow supports. Anything else (a
// color() or oklch() value) is reported as unknown rather than guessed.
const RGB = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i;
export function parseColor(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const m = RGB.exec(v);
  if (!m) return null;
  let a = m[4] === undefined ? 1 : Number.parseFloat(m[4]);
  if (m[4]?.endsWith('%')) a /= 100;
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: Math.max(0, Math.min(1, a)) };
}

// `top` painted over an opaque `bottom`.
export function composite(top, bottom) {
  const a = top.a;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

// WCAG 2 relative luminance and contrast ratio.
export function luminance({ r, g, b }) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Not <noscript>: the email frame runs without scripts, so a browser shows its content as text.
// Whether a computed background-image paints anything. A remote background image blocked by
// MailFlow (backend emailSanitizer.js blockRemoteImages) is left as url("data:,"), which draws
// nothing, so it counts as none.
const BLOCKED_IMAGE = /url\(\s*["']?data:,["']?\s*\)/gi;
export function paintsImage(backgroundImage) {
  if (!backgroundImage || backgroundImage === 'none') return false;
  return backgroundImage.replace(BLOCKED_IMAGE, '').replace(/[\s,]/g, '').replace(/none/gi, '') !== '';
}

const SKIP_PARENTS = new Set(['STYLE', 'SCRIPT', 'TEMPLATE', 'TITLE', 'HEAD']);
const CLIPPING = new Set(['hidden', 'clip', 'auto', 'scroll']);
const WHITE = { r: 255, g: 255, b: 255, a: 1 };

// What is painted behind an element's content: a single color, or `overImage` when a background
// image or gradient sits on top of it. `style` is a (cached) getComputedStyle.
function backgroundResolver(style, canvas) {
  const backgrounds = new Map();
  const backgroundOf = (el) => {
    if (!el) return { color: canvas, overImage: false, opacity: 1 };
    let b = backgrounds.get(el);
    if (b) return b;
    const parent = backgroundOf(el.parentElement);
    const s = style(el);
    let color = parent.color;
    let overImage = parent.overImage;
    const own = parseColor(s.backgroundColor);
    if (own === null) overImage = true;
    else if (own.a > 0) {
      color = composite(own, parent.color);
      if (own.a >= 0.999) overImage = false;
    }
    // An element paints its background image over its own background color.
    if (paintsImage(s.backgroundImage)) overImage = true;
    const opacity = parent.opacity * (Number.parseFloat(s.opacity) || 0);
    b = { color, overImage, opacity };
    backgrounds.set(el, b);
    return b;
  };
  return backgroundOf;
}

// Every piece of visible text in `doc`, with its contrast. Each entry carries `i`, the text's
// position among the document's non-blank text, so two renders of the same email (light and dark)
// can be compared piece by piece. `canvas` is what is painted under the page itself.
export function measureTextContrast(doc, { canvas = WHITE, samples = false } = {}) {
  const win = doc.defaultView;
  const styles = new Map();
  const style = (el) => {
    let s = styles.get(el);
    if (!s) { s = win.getComputedStyle(el); styles.set(el, s); }
    return s;
  };

  const backgroundOf = backgroundResolver(style, canvas);

  // Whether an ancestor that clips its overflow leaves none of `rect` showing.
  const clippedAway = (el, rect) => {
    for (let a = el; a && a !== doc.body && a !== doc.documentElement; a = a.parentElement) {
      const s = style(a);
      if (!CLIPPING.has(s.overflowX) && !CLIPPING.has(s.overflowY)) continue;
      const box = a.getBoundingClientRect();
      const w = Math.min(rect.right, box.right) - Math.max(rect.left, box.left);
      const h = Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top);
      if (w < 1 || h < 1) return true;
    }
    return false;
  };

  const docWidth = Math.max(doc.documentElement.scrollWidth, doc.body?.scrollWidth || 0);
  const range = doc.createRange();
  const walker = doc.createTreeWalker(doc.body || doc.documentElement, 4 /* NodeFilter.SHOW_TEXT */);
  const results = [];
  let i = -1;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || SKIP_PARENTS.has(el.tagName)) continue;
    const text = node.nodeValue.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    i += 1;

    const s = style(el);
    if (s.visibility !== 'visible') continue;
    const fontSize = Number.parseFloat(s.fontSize) || 0;
    if (fontSize < 3) continue;
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.width * rect.height < 2) continue;
    if (rect.right <= 0 || rect.left >= docWidth || rect.bottom <= -1000) continue;
    if (clippedAway(el, rect)) continue;

    const bg = backgroundOf(el);
    if (bg.opacity < 0.1) continue;
    const fg = parseColor(s.webkitTextFillColor || s.color) ?? parseColor(s.color);
    if (!fg) { results.push({ i, chars: text.length, ratio: null, large: false, overImage: bg.overImage }); continue; }
    if (fg.a * bg.opacity < 0.05) continue;
    const ink = composite({ ...fg, a: fg.a * bg.opacity }, bg.color);
    const weight = Number.parseInt(s.fontWeight, 10) || 400;
    const entry = {
      i,
      chars: text.length,
      ratio: Math.round(contrastRatio(ink, bg.color) * 100) / 100,
      large: fontSize >= 24 || (fontSize >= 18.66 && weight >= 700),
      overImage: bg.overImage,
    };
    if (samples) {
      entry.sample = text.slice(0, 60);
      entry.color = s.color;
      entry.background = `rgb(${Math.round(bg.color.r)}, ${Math.round(bg.color.g)}, ${Math.round(bg.color.b)})`;
    }
    results.push(entry);
  }
  range.detach?.();
  return results;
}

// Relative luminance above which a background reads as light; the dark-mode audit's brightShare
// counts screenshot pixels against the same line.
export const BRIGHT = 0.6;
const CONTENT = new Set(['IMG', 'SVG', 'svg', 'VIDEO', 'CANVAS', 'PICTURE', 'OBJECT', 'EMBED']);

// The share of `doc`'s visible area whose background is light, from a grid of points: what each
// point shows is the topmost element there, and what is painted behind it is worked out as for
// text. Images, and anything over a background image or gradient, are left out, as content rather
// than background. Null when nothing could be sampled (no layout).
export function brightShare(doc, { canvas = WHITE, columns = 24, maxPoints = 1200 } = {}) {
  const win = doc.defaultView;
  const root = doc.documentElement;
  const width = Math.min(root.scrollWidth, win.innerWidth);
  const height = Math.min(root.scrollHeight, win.innerHeight);
  if (!(width > 0 && height > 0) || typeof doc.elementFromPoint !== 'function') return null;
  const styles = new Map();
  const style = (el) => {
    let st = styles.get(el);
    if (!st) { st = win.getComputedStyle(el); styles.set(el, st); }
    return st;
  };
  const backgroundOf = backgroundResolver(style, canvas);
  const step = Math.max(width / columns, Math.sqrt((width * height) / maxPoints));
  let bright = 0;
  let counted = 0;
  for (let y = step / 2; y < height; y += step) {
    for (let x = step / 2; x < width; x += step) {
      const el = doc.elementFromPoint(x, y);
      if (!el || CONTENT.has(el.tagName) || el.closest?.('svg')) continue;
      const bg = backgroundOf(el);
      if (bg.overImage) continue;
      counted += 1;
      if (luminance(bg.color) > BRIGHT) bright += 1;
    }
  }
  return counted ? Math.round((bright / counted) * 1000) / 1000 : null;
}

// Below this, text is hard to read whatever its size; below the weak line it is below WCAG AA.
// Below HIDDEN it is drawn in (almost) the color behind it: in an email as sent, that is text the
// sender hid on purpose, such as preview text, not text anyone is meant to read.
export const UNREADABLE = 3;
export const HIDDEN = 1.5;
export const weakLine = (entry) => (entry.large ? 3 : 4.5);

// Totals for one render, by number of characters.
export function summarize(entries) {
  const out = { chars: 0, overImage: 0, unknown: 0, hidden: 0, unreadable: 0, weak: 0, worst: null };
  for (const e of entries) {
    out.chars += e.chars;
    if (e.overImage) { out.overImage += e.chars; continue; }
    if (e.ratio === null) { out.unknown += e.chars; continue; }
    if (e.ratio < HIDDEN) { out.hidden += e.chars; continue; }
    if (e.ratio < UNREADABLE) out.unreadable += e.chars;
    if (e.ratio < weakLine(e)) out.weak += e.chars;
    if (out.worst === null || e.ratio < out.worst) out.worst = e.ratio;
  }
  return out;
}

// What showing an email another way did to its text, against the email as sent (`light`), piece
// by piece: text that read as sent (and was not hidden by the sender) but does not any more.
// 'clean' means none, 'minor' at most 1% of the text or 20 characters, otherwise 'broken'.
export function compareWithLight(light, other) {
  const base = new Map(light.map(e => [e.i, e]));
  let counted = 0;
  let regressed = 0;
  const worst = [];
  for (const e of other) {
    const l = base.get(e.i);
    // Not shown in light, or shown at (almost) no contrast there: the sender's own hidden text.
    if (!l || l.ratio === null || l.ratio < HIDDEN || l.overImage) continue;
    if (e.overImage || e.ratio === null) continue;
    counted += e.chars;
    if (e.ratio < UNREADABLE && l.ratio >= UNREADABLE) {
      regressed += e.chars;
      worst.push({ ratio: e.ratio, lightRatio: l.ratio, chars: e.chars, sample: e.sample, color: e.color, background: e.background });
    }
  }
  worst.sort((a, b) => a.ratio - b.ratio || b.chars - a.chars);
  const verdict = regressed === 0 ? 'clean' : regressed <= Math.max(20, counted * 0.01) ? 'minor' : 'broken';
  return { counted, regressed, verdict, worst: worst.slice(0, 6) };
}

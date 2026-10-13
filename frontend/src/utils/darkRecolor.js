// Recoloring an email for a dark theme (#228): what Outlook calls partial invert.
//
// Works from the rendered email, not its CSS: the browser has already resolved every element's
// final colors, whatever the email's styles, inheritance and legacy attributes (bgcolor, <font>)
// said. Each color is moved in OKLCH (utils/oklch.js), keeping its hue:
//   backgrounds  light ones become dark (white becomes the theme's background); dark ones stay
//   text         made light enough to read on its new background, keeping its hue and at least the
//                contrast it had as sent (text the sender hid stays hidden)
//   borders      light lines become dark lines; dark lines are lightened only as far as needed
// Images are never touched, and neither is anything drawn over a background image or gradient:
// that part of the email is left as sent, as its colors cannot be read.
//
// The new colors are written as inline !important declarations, which win over any stylesheet
// rule the email has, and the old inline values are kept so the email can be put back exactly.
// Whether the result is readable is checked afterwards by utils/darkBody.js, which puts the email
// back if not.
import { rgbToOklch, oklchToRgb, formatRgb } from './oklch.js';
import { parseColor, composite, contrastRatio, HIDDEN, paintsImage } from './emailContrast.js';

// Below this lightness a color is already dark and is left alone.
export const PIVOT = 0.5;
// Contrast recolored text gets: at least AA, at most what the theme's own text has.
export const MIN_TEXT = 4.5;
export const MAX_TEXT = 15;
// A color this close to gray takes the theme's tint instead of its own.
const NEUTRAL = 0.02;
const WHITE = { r: 255, g: 255, b: 255, a: 1 };

const rgbOf = (value, fallback) => {
  const c = parseColor(value);
  if (c && c.a > 0) return { r: c.r, g: c.g, b: c.b, a: 1 };
  const hex = /^#([0-9a-f]{6})$/i.exec(String(value || '').trim());
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  return fallback;
};

// The theme's background and text in OKLCH, which the mapping is anchored to.
export function themeAnchors(palette) {
  const background = rgbOf(palette.background, { r: 15, g: 15, b: 17, a: 1 });
  const text = rgbOf(palette.text, { r: 232, g: 232, b: 240, a: 1 });
  const bg = rgbToOklch(background);
  return {
    background,
    text,
    // A theme background lighter than the pivot would turn the mapping around; no dark theme has one.
    bgL: Math.min(bg.L, PIVOT - 0.05),
    bgTint: { C: bg.C, h: bg.h },
    textTint: (({ C, h }) => ({ C, h }))(rgbToOklch(text)),
  };
}

const withA = (rgb) => ({ ...oklchToRgb(rgb), a: 1 });

// A background as it should look dark. Lightness above the pivot is mirrored into the band between
// the theme's background and the pivot, so white becomes the theme's background and a pale gray a
// shade lighter. Dark colors are kept as they are.
export function darkBackground(rgb, anchors) {
  const { L, C, h } = rgbToOklch(rgb);
  if (L <= PIVOT) return rgb;
  const mapped = PIVOT - ((L - PIVOT) * (PIVOT - anchors.bgL)) / (1 - PIVOT);
  return C < NEUTRAL
    ? withA({ L: mapped, C: anchors.bgTint.C, h: anchors.bgTint.h })
    : withA({ L: mapped, C: C * 0.9, h });
}

// The lightest-needed version of `rgb` (same hue and chroma, gamut allowing) that reaches `target`
// contrast on the dark background `bg`: as little lighter as the target needs, so a muted gray
// stays muted next to the main text.
export function lightenTo(rgb, bg, target, tint) {
  const lch = rgbToOklch(rgb);
  const { C, h } = lch.C < NEUTRAL && tint ? tint : lch;
  const at = (L) => withA({ L, C, h });
  if (contrastRatio(at(1), bg) < target) {
    const white = { ...WHITE };
    return contrastRatio(white, bg) > contrastRatio(at(1), bg) ? white : at(1);
  }
  let lo = Math.max(0, rgbToOklch(bg).L);
  let hi = 1;
  for (let i = 0; i < 20; i += 1) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(at(mid), bg) >= target) hi = mid; else lo = mid;
  }
  return at(hi);
}

// Text as it should look on its new background. `lightBg` is what it was drawn on as sent.
export function darkText(fg, lightBg, newBg, anchors) {
  const sent = contrastRatio(fg, lightBg);
  // The sender hid it (preview text in the background's color): keep it hidden.
  if (sent < HIDDEN) return newBg;
  const target = Math.min(Math.max(sent, MIN_TEXT), MAX_TEXT);
  if (contrastRatio(fg, newBg) >= target) return fg;
  return lightenTo(fg, newBg, target, anchors.textTint);
}

// A border line on its new background: light lines darken like backgrounds; a dark line is
// lightened only as far as needed to stay as visible as it was (at most 3:1, a UI line's need).
export function darkBorder(color, lightBg, newBg, anchors) {
  if (rgbToOklch(color).L > PIVOT) return darkBackground(color, anchors);
  const target = Math.min(contrastRatio(color, lightBg), 3);
  if (contrastRatio(color, newBg) >= target) return color;
  return lightenTo(color, newBg, target, anchors.textTint);
}

// Not <noscript>: the frame runs without scripts, so a browser shows its content like any other.
const SKIP = new Set(['HEAD', 'STYLE', 'SCRIPT', 'TITLE', 'META', 'LINK', 'BASE', 'TEMPLATE', 'IMG', 'PICTURE', 'VIDEO', 'SVG']);
const SIDES = ['top', 'right', 'bottom', 'left'];
const same = (a, b) => Math.round(a.r) === Math.round(b.r) && Math.round(a.g) === Math.round(b.g) && Math.round(a.b) === Math.round(b.b);
const hasOwnText = (el) => {
  for (const node of el.childNodes) if (node.nodeType === 3 && node.nodeValue.trim()) return true;
  return false;
};

// Works out every change from the email as it is now (as sent) before making any, so no reading
// sees a color already changed. Returns [element, property, value] triples.
export function planRecolor(doc, palette) {
  const win = doc.defaultView;
  const anchors = themeAnchors(palette);
  const plan = [];
  // Per element: what its content is drawn on as sent and once recolored, and whether it is part
  // of a region left as sent (drawn over a background image).
  const state = new Map();
  const rootState = { lightBg: WHITE, newBg: anchors.background, island: false };
  const root = doc.documentElement;
  const elements = [root, ...root.querySelectorAll('*')];
  for (const el of elements) {
    if (SKIP.has(el.tagName.toUpperCase()) || (el !== root && el.closest('head, svg'))) continue;
    const parent = state.get(el.parentElement) ?? rootState;
    const s = win.getComputedStyle(el);
    let { lightBg, newBg, island } = parent;
    const own = parseColor(s.backgroundColor);
    const image = paintsImage(s.backgroundImage);
    if (island || image || own === null) {
      // Over a background image (or a background color this cannot read): left as sent, and
      // everything inside it too.
      if (own && own.a > 0) lightBg = composite(own, lightBg);
      island = true;
      newBg = lightBg;
    } else if (own.a > 0) {
      lightBg = composite(own, lightBg);
      newBg = darkBackground(lightBg, anchors);
      plan.push([el, 'background-color', formatRgb(newBg)]);
    }
    state.set(el, { lightBg, newBg, island });
    if (island) continue;

    // A list item's bullet is drawn in its color even when its text sits in a child element.
    if (hasOwnText(el) || s.display === 'list-item') {
      const color = parseColor(s.color);
      const fill = parseColor(s.webkitTextFillColor);
      if (color && color.a > 0) plan.push([el, 'color', formatRgb(darkText(composite(color, lightBg), lightBg, newBg, anchors))]);
      // Text is drawn in -webkit-text-fill-color, which follows color only while nobody set it. A
      // fill matching the color as sent may still be one an ancestor set explicitly, inherited, and
      // then it would keep the old color: make it follow the new one. A fill of its own color is
      // recolored on its own.
      if (fill && color && fill.a === color.a && same(fill, color)) {
        plan.push([el, '-webkit-text-fill-color', 'currentcolor']);
      } else if (fill && fill.a > 0) {
        plan.push([el, '-webkit-text-fill-color', formatRgb(darkText(composite(fill, lightBg), lightBg, newBg, anchors))]);
      }
    }

    for (const side of SIDES) {
      const width = Number.parseFloat(s.getPropertyValue(`border-${side}-width`)) || 0;
      const lineStyle = s.getPropertyValue(`border-${side}-style`);
      if (width <= 0 || lineStyle === 'none' || lineStyle === 'hidden') continue;
      const line = parseColor(s.getPropertyValue(`border-${side}-color`));
      if (!line || line.a === 0) continue;
      const shown = composite(line, lightBg);
      const next = darkBorder(shown, lightBg, newBg, anchors);
      if (!same(next, shown) || line.a < 1) plan.push([el, `border-${side}-color`, formatRgb(next)]);
    }
  }
  return plan;
}

// Makes the planned changes; returns a function that undoes them exactly.
export function applyPlan(plan) {
  const saved = plan.map(([el, prop]) => [el, prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
  for (const [el, prop, value] of plan) el.style.setProperty(prop, value, 'important');
  return () => {
    for (let i = saved.length - 1; i >= 0; i -= 1) {
      const [el, prop, value, priority] = saved[i];
      if (value) el.style.setProperty(prop, value, priority);
      else el.style.removeProperty(prop);
    }
  };
}

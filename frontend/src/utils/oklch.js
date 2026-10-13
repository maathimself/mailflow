// OKLCH color math for dark email bodies (#228).
//
// OKLab (Björn Ottosson, 2020) is a perceptual color space: equal steps in L look like equal steps
// in lightness, and changing L keeps the hue. That is what recoloring an email needs: a light-blue
// banner becomes a dark blue, not a muddy gray, and red text stays red when it is lightened.
//
// Colors are { r, g, b } with channels 0-255, as utils/emailContrast.js uses them.

const toLinear = (c) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (c) => {
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return s * 255;
};

function rgbToOklab({ r, g, b }) {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  };
}

// Linear sRGB, which may fall outside 0-1 for a color sRGB cannot show.
function oklabToLinear({ L, a, b }) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  };
}

export function rgbToOklch(rgb) {
  const { L, a, b } = rgbToOklab(rgb);
  const C = Math.hypot(a, b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L, C, h };
}

const EPS = 1e-4;
const inGamut = (lin) => [lin.r, lin.g, lin.b].every(c => c >= -EPS && c <= 1 + EPS);
const labOf = (L, C, h) => ({ L, a: C * Math.cos((h * Math.PI) / 180), b: C * Math.sin((h * Math.PI) / 180) });

// The sRGB color at this lightness and hue with as much of the chroma as sRGB can show: chroma is
// reduced, never lightness or hue, so the color keeps the lightness it was given.
export function oklchToRgb({ L, C, h }) {
  const light = Math.max(0, Math.min(1, L));
  let chroma = Math.max(0, C);
  let lin = oklabToLinear(labOf(light, chroma, h));
  if (!inGamut(lin)) {
    let lo = 0;
    let hi = chroma;
    for (let i = 0; i < 24; i += 1) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklabToLinear(labOf(light, mid, h)))) lo = mid; else hi = mid;
    }
    chroma = lo;
    lin = oklabToLinear(labOf(light, chroma, h));
  }
  const channel = (c) => Math.round(Math.max(0, Math.min(255, fromLinear(Math.max(0, Math.min(1, c))))));
  return { r: channel(lin.r), g: channel(lin.g), b: channel(lin.b) };
}

export const formatRgb = ({ r, g, b }) => `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;

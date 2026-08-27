const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

const byte = value => clamp(finiteNumber(value), 0, 255);
const alpha = value => clamp(finiteNumber(value), 0, 1);

function normalizedColor(color = {}) {
  return {
    r: byte(color.r),
    g: byte(color.g),
    b: byte(color.b),
    a: alpha(color.a),
  };
}

function parseNumber(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const token = value.trim();
  if (!/^[+-]?(?:(?:\d+\.\d*)|(?:\.\d+)|\d+)(?:e[+-]?\d+)?$/i.test(token)) return null;
  const number = Number(token);
  return Number.isFinite(number) ? number : null;
}

function parseRgbChannel(value) {
  const token = value.trim();
  if (token.endsWith('%')) {
    const percentage = parseNumber(token.slice(0, -1));
    return percentage === null ? null : byte(percentage * 2.55);
  }
  const number = parseNumber(token);
  return number === null ? null : byte(number);
}

function parseAlpha(value) {
  const token = value.trim();
  if (token.endsWith('%')) {
    const percentage = parseNumber(token.slice(0, -1));
    return percentage === null ? null : alpha(percentage / 100);
  }
  const number = parseNumber(token);
  return number === null ? null : alpha(number);
}

export function parseCssColor(value) {
  if (typeof value !== 'string') return null;
  const input = value.trim().toLowerCase();
  if (input === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

  const hex = input.match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i);
  if (hex) {
    const source = hex[1];
    const expanded = source.length <= 4
      ? [...source].map(channel => channel + channel).join('')
      : source;
    return {
      r: Number.parseInt(expanded.slice(0, 2), 16),
      g: Number.parseInt(expanded.slice(2, 4), 16),
      b: Number.parseInt(expanded.slice(4, 6), 16),
      a: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
    };
  }

  const match = input.match(/^(rgb|rgba)\((.*)\)$/i);
  if (!match) return null;
  const [, functionName, contents] = match;
  let channels;
  let opacity = 1;

  if (contents.includes(',')) {
    const parts = contents.split(',').map(part => part.trim());
    if (parts.length !== (functionName === 'rgba' ? 4 : 3) || parts.some(part => part === '')) return null;
    channels = parts.slice(0, 3).map(parseRgbChannel);
    if (parts.length === 4) opacity = parseAlpha(parts[3]);
  } else {
    const parts = contents.split('/');
    if (parts.length > 2) return null;
    channels = parts[0].trim().split(/\s+/).map(parseRgbChannel);
    if (channels.length !== 3 || (functionName === 'rgba' && parts.length !== 2)) return null;
    if (parts.length === 2) opacity = parseAlpha(parts[1]);
  }

  if (channels.some(channel => channel === null) || opacity === null) return null;
  return { r: channels[0], g: channels[1], b: channels[2], a: opacity };
}

// Computed styles may preserve modern color syntax instead of serializing to
// rgb(). A one-pixel sRGB canvas lets the browser perform the standards-aware
// conversion for every color syntax it supports without expanding this parser
// into a second CSS color engine.
export function createCssColorParser(doc) {
  let context;
  const cache = new Map();

  return value => {
    const direct = parseCssColor(value);
    if (direct || typeof value !== 'string' || !value.trim()) return direct;
    const key = value.trim().toLowerCase();
    if (cache.has(key)) return cache.get(key);

    if (context === undefined) {
      try {
        const canvas = doc?.createElement?.('canvas');
        if (canvas) {
          canvas.width = 1;
          canvas.height = 1;
          context = canvas.getContext('2d', { willReadFrequently: true }) || null;
        } else {
          context = null;
        }
      } catch {
        context = null;
      }
    }

    let parsed = null;
    if (context) {
      try {
        // Invalid assignments leave fillStyle unchanged. Two different
        // sentinels distinguish that from any valid color equal to one sentinel.
        context.fillStyle = '#010203';
        context.fillStyle = value;
        const first = context.fillStyle;
        context.fillStyle = '#040506';
        context.fillStyle = value;
        if (context.fillStyle === first) {
          context.clearRect(0, 0, 1, 1);
          context.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
          parsed = { r, g, b, a: a / 255 };
        }
      } catch { /* Treat unavailable or blocked canvas reads as an invalid color. */ }
    }
    cache.set(key, parsed);
    return parsed;
  };
}

export function formatCssColor(color) {
  const { r, g, b, a } = normalizedColor(color);
  const channels = [r, g, b].map(channel => Math.round(channel));
  if (a === 1) return `rgb(${channels.join(', ')})`;
  const opacity = Math.round(a * 10000) / 10000;
  return `rgba(${channels.join(', ')}, ${opacity})`;
}

export function compositeColors(foreground, background) {
  const front = normalizedColor(foreground);
  const back = normalizedColor(background);
  const a = front.a + back.a * (1 - front.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (front.r * front.a + back.r * back.a * (1 - front.a)) / a,
    g: (front.g * front.a + back.g * back.a * (1 - front.a)) / a,
    b: (front.b * front.a + back.b * back.a * (1 - front.a)) / a,
    a,
  };
}

function linearChannel(channel) {
  const value = byte(channel) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color) {
  return 0.2126 * linearChannel(color?.r)
    + 0.7152 * linearChannel(color?.g)
    + 0.0722 * linearChannel(color?.b);
}

export function contrastRatio(foreground, background) {
  const back = normalizedColor(background);
  const opaqueBackground = back.a < 1
    ? compositeColors(back, { r: 255, g: 255, b: 255, a: 1 })
    : back;
  const opaqueForeground = compositeColors(foreground, opaqueBackground);
  const a = relativeLuminance(opaqueForeground);
  const b = relativeLuminance(opaqueBackground);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function rgbToHsl(color) {
  const { r, g, b } = normalizedColor(color);
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const l = (max + min) / 2;
  if (delta === 0) return { h: 0, s: 0, l };

  const s = delta / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === red) h = ((green - blue) / delta) % 6;
  else if (max === green) h = (blue - red) / delta + 2;
  else h = (red - green) / delta + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

export function hslToRgb(hsl = {}) {
  const h = ((finiteNumber(hsl.h) % 360) + 360) % 360;
  const s = clamp(finiteNumber(hsl.s), 0, 1);
  const l = clamp(finiteNumber(hsl.l), 0, 1);
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const second = chroma * (1 - Math.abs((h / 60) % 2 - 1));
  const match = l - chroma / 2;
  let red = 0;
  let green = 0;
  let blue = 0;
  if (h < 60) [red, green] = [chroma, second];
  else if (h < 120) [red, green] = [second, chroma];
  else if (h < 180) [green, blue] = [chroma, second];
  else if (h < 240) [green, blue] = [second, chroma];
  else if (h < 300) [red, blue] = [second, chroma];
  else [red, blue] = [chroma, second];
  return { r: (red + match) * 255, g: (green + match) * 255, b: (blue + match) * 255 };
}

export function mixColors(first, second, amount) {
  const a = normalizedColor(first);
  const b = normalizedColor(second);
  const mix = clamp(finiteNumber(amount), 0, 1);
  return {
    r: a.r + (b.r - a.r) * mix,
    g: a.g + (b.g - a.g) * mix,
    b: a.b + (b.b - a.b) * mix,
    a: a.a + (b.a - a.a) * mix,
  };
}

export function isNeutralColor(color, role) {
  const threshold = role === 'background' ? 0.12 : 0.24;
  return rgbToHsl(color).s <= threshold + 4 * Number.EPSILON;
}

function candidateAtLightness(sourceHsl, opacity, lightness) {
  return { ...hslToRgb({ ...sourceHsl, l: lightness }), a: opacity };
}

export function repairColorContrast(foreground, background, minimum) {
  if (!Number.isFinite(minimum) || minimum < 1) return null;
  const sourceColor = normalizedColor(foreground);
  const backgroundColor = normalizedColor(background);
  if (contrastRatio(sourceColor, backgroundColor) >= minimum) return foreground;
  const source = rgbToHsl(sourceColor);
  const candidates = [];

  for (const extreme of [0, 1]) {
    const edge = candidateAtLightness(source, sourceColor.a, extreme);
    if (contrastRatio(edge, backgroundColor) < minimum) continue;
    let failing = source.l;
    let passing = extreme;
    for (let i = 0; i < 24; i += 1) {
      const mid = (failing + passing) / 2;
      const candidate = candidateAtLightness(source, sourceColor.a, mid);
      if (contrastRatio(candidate, backgroundColor) >= minimum) passing = mid;
      else failing = mid;
    }
    candidates.push(candidateAtLightness(source, sourceColor.a, passing));
  }

  candidates.sort((a, b) => Math.abs(rgbToHsl(a).l - source.l) - Math.abs(rgbToHsl(b).l - source.l));
  return candidates[0] || null;
}

import { THEMES } from '../themes.js';
import {
  formatCssColor,
  parseCssColor,
  relativeLuminance,
  repairColorContrast,
} from './emailColors.js';

export const EMAIL_PALETTE_VARS = {
  background: '--bg-secondary',
  elevated: '--bg-elevated',
  text: '--text-primary',
  mutedText: '--text-secondary',
  accent: '--accent',
  border: '--border',
};

const PALETTE_ROLES = Object.keys(EMAIL_PALETTE_VARS);
const OPAQUE_SURFACES = new Set(['background', 'elevated']);

function firstColor(...values) {
  for (const value of values) {
    const parsed = parseCssColor(value);
    if (parsed) return parsed;
  }
  return null;
}

function usableColor(role, ...values) {
  if (!OPAQUE_SURFACES.has(role)) return firstColor(...values);
  for (const value of values) {
    const parsed = parseCssColor(value);
    if (parsed && (!OPAQUE_SURFACES.has(role) || parsed.a === 1)) return parsed;
  }
  return null;
}

function varsFor(role, vars) {
  return vars?.[EMAIL_PALETTE_VARS[role]];
}

function buildCandidate(raw = {}, builtIn = {}, defaultPalette = {}) {
  const palette = {};
  for (const role of PALETTE_ROLES) {
    palette[role] = usableColor(role, raw[role], varsFor(role, builtIn), varsFor(role, defaultPalette));
    if (!palette[role]) return null;
  }

  for (const [role, minimum] of [['text', 4.5], ['accent', 4.5], ['border', 3]]) {
    const repaired = repairColorContrast(palette[role], palette.background, minimum);
    if (!repaired) return null;
    palette[role] = repaired;
  }

  palette.scheme = relativeLuminance(palette.background) < 0.35 ? 'dark' : 'light';
  palette.fingerprint = PALETTE_ROLES.map(role => formatCssColor(palette[role])).join('|');
  return palette;
}

export function buildEmailPalette(raw = {}, builtIn = THEMES.dark.vars, defaultPalette = THEMES.dark.vars) {
  const fallback = defaultPalette || THEMES.dark.vars;
  return buildCandidate(raw, builtIn, fallback)
    || buildCandidate({}, builtIn, fallback)
    || buildCandidate({}, fallback, THEMES.dark.vars);
}

function sameColor(first, second) {
  if (!first || !second) return false;
  return ['r', 'g', 'b', 'a'].every(channel => Math.abs(first[channel] - second[channel]) <= 0.001);
}

export function resolveEmailPalette(doc, themeName) {
  const probe = 'rgba(1, 2, 3, 0.123)';
  const wrapper = doc.createElement('div');
  wrapper.dataset.mailflowPaletteProbe = '';
  wrapper.style.cssText = 'position:fixed;left:-10000px;visibility:hidden;pointer-events:none';
  wrapper.style.setProperty('color', probe, 'important');
  doc.documentElement.appendChild(wrapper);

  try {
    const raw = {};
    for (const [role, variable] of Object.entries(EMAIL_PALETTE_VARS)) {
      const child = doc.createElement('span');
      child.style.setProperty('color', `var(${variable})`, 'important');
      wrapper.appendChild(child);
      const resolved = doc.defaultView.getComputedStyle(child).color;
      raw[role] = sameColor(parseCssColor(resolved), parseCssColor(probe)) ? null : resolved;
    }
    return buildEmailPalette(raw, THEMES[themeName]?.vars, THEMES.dark.vars);
  } finally {
    wrapper.remove();
  }
}

export { firstColor };

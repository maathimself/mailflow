// Showing a rendered email body dark (#228), in place, in its frame's document.
//
// The frame always renders the email as sent first (utils/emailFrameDoc.js). Showing it dark
// measures that rendering's text, then tries, in order:
//   1. 'sender'   the sender's own dark design, when the email carries one: MailFlow's dark styles
//                 plus their @media (prefers-color-scheme: dark) CSS
//   2. 'recolor'  MailFlow's own recoloring (utils/darkRecolor.js)
// and keeps the first that leaves every piece of text that read as sent still readable
// (utils/emailContrast.js compareWithLight). If neither does, the email is put back as sent and
// the outcome is 'light': a wrong guess costs a light email, never unreadable text.
//
// The document is the frame's own; this runs in the reader's page, which can reach into the
// sandboxed frame because it is same-origin (the frame's CSP forbids scripts inside it).
import { FRAME_STYLE, DARK_DEFAULTS } from './emailFrameDoc.js';
import { measureTextContrast, compareWithLight } from './emailContrast.js';
import { planRecolor, applyPlan, themeAnchors } from './darkRecolor.js';
import { darkenImages } from './darkImages.js';

// Per document: its light measurement (taken once, the text never changes) and how to undo
// whatever is shown now.
const states = new WeakMap();
const stateOf = (doc) => {
  let state = states.get(doc);
  if (!state) { state = { light: null, undo: null, outcome: 'light' }; states.set(doc, state); }
  return state;
};

function setMedia(doc, id, on) {
  const el = doc.getElementById(id);
  if (el) el.media = on ? 'all' : 'not all';
}

function setColorScheme(doc, value) {
  const meta = doc.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute('content', value);
}

// MailFlow's dark styles, with the sender's dark design on top or ('naive') without it.
function switchStyles(doc, withSender) {
  setMedia(doc, FRAME_STYLE.light, false);
  setMedia(doc, FRAME_STYLE.dark, true);
  setMedia(doc, FRAME_STYLE.sender, withSender);
  setColorScheme(doc, 'dark');
  return () => {
    setMedia(doc, FRAME_STYLE.sender, false);
    setMedia(doc, FRAME_STYLE.dark, false);
    setMedia(doc, FRAME_STYLE.light, true);
    setColorScheme(doc, 'only light');
  };
}

// Runs `fn` with CSS transitions switched off. Many emails animate color changes (links fading on
// hover); left on, switching colors would start those animations, and measuring right after would
// read colors halfway between old and new: dark text on the new dark background, an email
// refused for nothing. Styles are settled before transitions come back, and that alone changes no
// color, so nothing animates afterwards either.
//
// The rule below cannot win against an email's own `transition: ... !important` with a more
// specific selector, or inline; finishTransitions catches what still starts.
function withoutTransitions(doc, fn) {
  const style = doc.createElement('style');
  style.textContent = '*, *::before, *::after { transition: none !important; }';
  (doc.head || doc.documentElement).appendChild(style);
  try {
    return fn();
  } finally {
    void doc.documentElement.offsetHeight;
    style.remove();
  }
}

// Jumps every running CSS transition in `doc` to its end, so what is measured next is what is
// shown. Asking for the document's animations also brings its styles up to date, which is what
// starts any transition a change just caused. CSS animations (@keyframes) are left alone: MailFlow's
// colors are !important, which animations cannot override.
function finishTransitions(doc) {
  for (const animation of doc.getAnimations?.() ?? []) {
    if ('transitionProperty' in animation) animation.finish();
  }
}

const hasSenderDesign = (doc) => Boolean(doc.getElementById(FRAME_STYLE.sender)?.textContent.trim());

// Each way of showing it dark: makes its changes and returns how to undo them, and what it did to
// images (utils/darkImages.js). MailFlow's blocked-image placeholders are drawn dark either way;
// images that would vanish get a backing only when MailFlow recolored the email.
const both = (undoColors, images) => ({ undo: () => { images.undo(); undoColors(); }, images: images.counts });
const KINDS = {
  sender: (doc) => both(switchStyles(doc, true), darkenImages(doc)),
  naive: (doc) => both(switchStyles(doc, false), darkenImages(doc)),
  recolor: (doc, palette) => both(applyPlan(planRecolor(doc, palette)), darkenImages(doc, { backings: true })),
};

// Shows `doc` dark. `mode` 'auto' is what the reader uses; 'sender', 'recolor' and 'naive' force
// one way without the readability check, for the audit harness. Returns the outcome ('sender',
// 'recolor', 'naive' or 'light'), each attempt's comparison, and how long it took.
export function applyDarkBody(doc, options = {}) {
  return withoutTransitions(doc, () => showDark(doc, options));
}

function showDark(doc, { palette = DARK_DEFAULTS, mode = 'auto', samples = false }) {
  const win = doc.defaultView;
  const started = win?.performance?.now?.() ?? Date.now();
  restore(doc);
  const state = stateOf(doc);
  if (!state.light) state.light = measureTextContrast(doc, { samples });
  const canvas = { ...themeAnchors(palette).background, a: 1 };

  const order = mode === 'auto' ? [...(hasSenderDesign(doc) ? ['sender'] : []), 'recolor'] : [mode];
  const attempts = [];
  let dark = null;
  let images = null;
  for (const kind of order) {
    const shown = KINDS[kind](doc, palette);
    const { undo } = shown;
    images = shown.images;
    finishTransitions(doc);
    dark = measureTextContrast(doc, { canvas, samples });
    const comparison = compareWithLight(state.light, dark);
    attempts.push({ kind, ...comparison });
    if (mode !== 'auto' || comparison.verdict === 'clean') {
      state.undo = undo;
      state.outcome = kind;
      return finish(kind);
    }
    undo();
    finishTransitions(doc);
  }
  state.outcome = 'light';
  images = null;
  return finish('light');

  // `images` counts what was done to images when shown dark (some may still be loading).
  function finish(outcome) {
    const ms = (win?.performance?.now?.() ?? Date.now()) - started;
    return { outcome, attempts, ms, images, ...(samples ? { light: state.light, dark: outcome === 'light' ? state.light : dark } : {}) };
  }
}

// Puts `doc` back as sent.
export function restoreBody(doc) {
  if (states.get(doc)?.undo) withoutTransitions(doc, () => restore(doc));
}

function restore(doc) {
  const state = states.get(doc);
  if (!state) return;
  state.undo?.();
  state.undo = null;
  state.outcome = 'light';
  finishTransitions(doc);
}

// What `doc` shows now: 'light' (as sent), 'sender', 'recolor' or 'naive'.
export const bodyOutcome = (doc) => states.get(doc)?.outcome ?? 'light';

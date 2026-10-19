// Fitting a wide email to the width of its frame (#641).
//
// Some marketing emails lock their layout to a fixed pixel width with class-based !important
// rules our injected CSS cannot override. Those are scaled down as a whole (#mf-scale-wrapper
// gets a transform) so nothing is cut off: the frame clips its overflow and has no scrollbar.
//
// The fit is not settled once the email opens. The email can grow wider afterwards (a table
// sized by an image that had not loaded yet, a web font), and the frame can get narrower or wider
// (the sidebar collapsing, a divider dragged, the window resized). MessageBodyView runs the fit
// again on each, so these helpers are safe to call any number of times on the same document.

import { SCALE_WRAPPER } from './emailFrameDoc.js';

// Content at most this much wider than the frame is sub-pixel rounding, not a wide email.
export const FIT_TOLERANCE_PX = 2;
// Right after shrinking, a larger scale is only taken again when that frees more than this much
// width. Wider than a classic scrollbar: a frame that grows tall enough to give the pane a
// scrollbar is that much narrower, and the smaller scale it then needs makes it shorter again.
// Without the margin, a frame right at that height would flip between the two scales forever.
export const GROW_SLACK_PX = 24;

// The scale to show content `contentW` wide in a frame `frameW` wide, given the one shown now.
// Shrinks whenever the content would be clipped; grows back (to 1 at most) only when that gains
// more than `growSlack` px, or never with `allowGrow` false.
export function fitScale({ frameW, contentW, scale = 1, allowGrow = true, growSlack = 0 }) {
  const current = Number.isFinite(scale) && scale > 0 ? scale : 1;
  if (!(frameW > 0) || !(contentW > 0)) return current;
  const target = contentW > frameW + FIT_TOLERANCE_PX ? frameW / contentW : 1;
  const shown = contentW * current;
  if (shown > frameW + FIT_TOLERANCE_PX) return target;
  if (allowGrow && target > current && frameW - shown > growSlack) return target;
  return current;
}

// The email's natural width: unscaled, laid out at the frame's own width.
function measureContentWidth(doc, wrapper) {
  const b = doc.body;
  const h = doc.documentElement;
  wrapper.style.removeProperty('transform');
  wrapper.style.removeProperty('transform-origin');
  wrapper.style.removeProperty('width');
  // iOS Safari clamps scrollWidth to the iframe viewport when overflow:hidden
  // is set on html/body, so wide fixed-layout emails are never detected.
  // Temporarily expose overflow-x inline (beating the !important stylesheet
  // rule) to let scrollWidth reflect the true content width, then restore.
  // Note: overflow-x:visible is coerced to auto when overflow-y is non-visible:
  // that's fine; auto still returns the real scrollable content width.
  if (b) b.style.setProperty('overflow-x', 'visible', 'important');
  if (h) h.style.setProperty('overflow-x', 'visible', 'important');
  const contentW = Math.max(h ? h.scrollWidth : 0, b ? b.scrollWidth : 0);
  if (b) b.style.removeProperty('overflow-x');
  if (h) h.style.removeProperty('overflow-x');
  return contentW;
}

// Fits the email in `doc` to a frame `frameW` wide and returns the scale now shown. `scale` is
// the one shown before; `limits` are fitScale's allowGrow and growSlack (see createFitGuard).
export function fitEmailToFrame(doc, frameW, { scale = 1, ...limits } = {}) {
  const wrapper = doc?.getElementById(SCALE_WRAPPER);
  if (!wrapper || !(frameW > 0)) return 1;
  const contentW = measureContentWidth(doc, wrapper);
  const next = fitScale({ frameW, contentW, scale, ...limits });
  if (next < 1) {
    wrapper.style.transform       = `scale(${next})`;
    wrapper.style.transformOrigin = 'top left';
    // Lock the wrapper at its natural content width so the scale
    // maps exactly contentW → frameW with no clipping.
    wrapper.style.width           = `${contentW}px`;
  }
  return next;
}

// Whether the email has grown wider than the box it is laid out in since it was last fitted:
// cheap enough to ask whenever its size changes, where fitting again would lay it out twice.
export function contentOverflows(doc) {
  const wrapper = doc?.getElementById(SCALE_WRAPPER);
  return !!wrapper && wrapper.scrollWidth > wrapper.clientWidth + FIT_TOLERANCE_PX;
}

// Keeps refitting from flipping between two scales. Growing right after a shrink waits for
// GROW_SLACK_PX of room (the pane scrollbar above); a frame widening step by step (a sidebar's
// transition, a divider dragged) grows freely after its first step, so it ends exactly fitted.
// Backstop for a layout that flips anyway (a media query switching at the very width a scrollbar
// takes away, say): after `reversals` changes of direction within `windowMs`, the email only
// shrinks, which cannot go on forever and never clips, until the frame's width moves by more than
// `releasePx` (the reader resizing something).
export function createFitGuard({ reversals = 4, windowMs = 2000, releasePx = 50 } = {}) {
  let lastDir = 0;
  let times = [];
  let lockedAt = null;
  return {
    limits(frameW) {
      if (lockedAt !== null && Math.abs(frameW - lockedAt) > releasePx) { lockedAt = null; times = []; }
      return { allowGrow: lockedAt === null, growSlack: lastDir < 0 ? GROW_SLACK_PX : 0 };
    },
    record(prev, next, frameW, now) {
      const dir = Math.sign(next - prev);
      if (!dir) return;
      if (lastDir && dir !== lastDir) {
        times = times.filter(t => now - t < windowMs);
        times.push(now);
        if (times.length >= reversals) lockedAt = frameW;
      }
      lastDir = dir;
    },
  };
}

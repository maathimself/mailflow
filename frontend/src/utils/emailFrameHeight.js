// Height measurement for the email <iframe> in MessagePane.
//
// Why this exists
// ---------------
// The frame is sized to its content so the outer pane owns the only scrollbar.
// The obvious way to measure that content is `documentElement.scrollHeight`, and
// that is a trap: the document element's scroll height is floored by the frame's
// own viewport. Once the frame has been set to N pixels tall, every later
// measurement returns at least N, so the measured height can only ever go up.
// A single over-measurement (a stale document, a mid-load reflow, a transient
// narrow width that triggers the email's mobile media queries) is then permanent,
// and the user sees dead whitespace under the email for as long as it is open.
//
// The fix is to never measure the document element. `wrapper.offsetHeight` and
// `body.scrollHeight` are ordinary layout boxes with no viewport floor, so they
// report the real content height and are free to shrink. That in turn makes it
// safe to apply a height that is smaller than the current one, which is what
// actually clears the whitespace.
//
// Shrinking is safe because content height does not depend on frame height here:
// MessagePane forces `html, body { height: auto !important; min-height: 0 }`, so
// no percentage height resolves against the viewport, and CSS media queries key
// off width, never height. `createHeightController` still carries an oscillation
// guard for anything that slips past that reasoning.

/**
 * Content height of the email, in CSS pixels, measured from sources that are not
 * floored by the iframe viewport.
 *
 * `wrapperOffsetHeight` is the layout height of #mf-scale-wrapper. offsetHeight is
 * used rather than getBoundingClientRect().height because the wrapper may carry a
 * `transform: scale(...)` for wide fixed-layout emails: offsetHeight ignores
 * transforms and so stays in the same (untransformed) space the caller's scale
 * factor expects, while getBoundingClientRect would already have the scale baked
 * in and would double-apply it.
 *
 * `bodyScrollHeight` is a backstop for content that escapes the wrapper box, for
 * example a floated or absolutely positioned element.
 */
export function measureContentHeight({
  wrapperOffsetHeight = 0,
  wrapperOffsetTop = 0,
  bodyScrollHeight = 0,
  bodyOffsetHeight = 0,
} = {}) {
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  return Math.max(
    n(wrapperOffsetTop) + n(wrapperOffsetHeight),
    n(bodyScrollHeight),
    n(bodyOffsetHeight),
  );
}

/**
 * Tracks the height applied to the frame and decides when to change it.
 *
 * `next(measured, scale)` returns the height to apply, or null to leave the frame
 * alone. Unlike the previous grow-only ratchet it will return a smaller value, so
 * an over-estimate can be corrected instead of persisting.
 *
 * Guards, in order of how likely they are to matter:
 *   tolerancePx  ignore sub-pixel churn, which otherwise ping-pongs forever
 *                against a ResizeObserver.
 *   oscillation  if a height we have already applied comes back around after
 *                moving away from it, the layout is unstable. Freeze at the
 *                tallest height seen, because too much space is a cosmetic
 *                problem and too little clips the email.
 *   maxCommits   absolute backstop against any feedback loop not caught above.
 */
export function createHeightController({ tolerancePx = 1, maxCommits = 60, historySize = 4 } = {}) {
  let current = null;
  let commits = 0;
  let frozen = false;
  let history = [];

  return {
    get height() { return current; },
    get frozen() { return frozen; },

    // Called when a new document is loaded into the frame. The frame's own height
    // is deliberately NOT seeded into `current`: the whole point is that the next
    // measurement is authoritative even when it is shorter than what is applied.
    reset() {
      current = null;
      commits = 0;
      frozen = false;
      history = [];
    },

    next(measured, scale = 1) {
      if (frozen) return null;
      if (!Number.isFinite(measured) || measured < 0) return null;

      const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
      const h = Math.max(0, Math.round(measured * factor));

      if (current !== null && Math.abs(h - current) <= tolerancePx) return null;

      // Unstable layout: settle on the tallest height rather than flapping.
      if (history.length >= 2 && history.includes(h) && h !== history[history.length - 1]) {
        frozen = true;
        const tallest = Math.max(...history, h);
        if (current === tallest) return null;
        current = tallest;
        return tallest;
      }

      current = h;
      history.push(h);
      if (history.length > historySize) history.shift();
      if (++commits >= maxCommits) frozen = true;
      return h;
    },
  };
}

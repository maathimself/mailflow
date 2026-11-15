import { useLayoutEffect, useRef } from 'react';

// The Gmail skin arranges a row or a reader for the width the pane really has. The viewport
// cannot say: the sidebar, a plugin's right sidebar and the font scale all take their share
// first, so a 1440px window can leave the list 380px. A CSS container query would read the
// same width, but it makes its container the containing block for the position: fixed menus
// inside these panes in engines that still apply layout containment.
export const PANE_NARROW_BELOW = 560;
export const PANE_MEDIUM_BELOW = 800;

// A width of 0 is a hidden or unmeasured pane: no tier, so the last one stays.
export function paneWidthTier(width) {
  if (!(width > 0)) return null;
  if (width < PANE_NARROW_BELOW) return 'narrow';
  return width < PANE_MEDIUM_BELOW ? 'medium' : 'wide';
}

// Writes data-pane-width on the element and keeps it current. clientWidth is in layout pixels,
// before the font-scale transform, which is the space the skin's own widths are in.
export function usePaneWidthTier(enabled) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return undefined;
    const apply = () => {
      const tier = paneWidthTier(el.clientWidth);
      if (tier && el.dataset.paneWidth !== tier) el.dataset.paneWidth = tier;
    };
    apply();
    if (typeof ResizeObserver === 'undefined') return () => { delete el.dataset.paneWidth; };
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => { observer.disconnect(); delete el.dataset.paneWidth; };
  }, [enabled]);
  return ref;
}

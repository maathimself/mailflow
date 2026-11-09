import { useLayoutEffect, useRef, useState } from 'react';

// The desktop list header shows the folder title and, beside it, the count and every control.
// When the list is too narrow for that, the header switches to its two-row form: count, sync
// and Select beside the title, Sort, Unread, page size and layout on a row below. Letting the
// one row wrap freely left the title alone on one line and stranded a single control on a
// third (#766 follow-up).

// The title may shrink to this before the controls move to their own row. A shorter title,
// like the All Inboxes icon, only needs its own width.
export const MIN_TITLE_WIDTH = 96;

// The width the controls take on one line: each control side by side plus the gaps between.
export function oneLineWidth(childWidths, gap) {
  const widths = childWidths.filter(w => w > 0);
  return widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, widths.length - 1);
}

// Whether the title and the one-line controls fit side by side in `available` pixels.
// Unknown sizes (0, before layout) count as fitting, so nothing changes until measured.
export function controlsFit({ available, controlsWidth, titleWidth, columnGap }) {
  if (!(available > 0) || !(controlsWidth > 0)) return true;
  const title = Math.min(MIN_TITLE_WIDTH, Math.max(0, titleWidth || 0));
  return available >= title + columnGap + controlsWidth;
}

// rowRef: the title row. titleRef: the title, which must not grow (flex-grow 0), so its
// scrollWidth is its own width rather than the space left over. controlsRef: the controls next to the title.
// extraRef: the second row of the two-row form. Both forms render the same controls, only split
// across one or two rows, so their one-line width is the same either way: switching forms cannot
// change the answer, and the header does not flicker. Measuring in both forms keeps the answer
// current when the count, the folder or the labels change.
export function useHeaderControlsFit(enabled, { gap, columnGap }) {
  const rowRef = useRef(null);
  const titleRef = useRef(null);
  const controlsRef = useRef(null);
  const extraRef = useRef(null);
  const [fits, setFits] = useState(true);

  useLayoutEffect(() => {
    if (!enabled) { setFits(true); return undefined; }
    const row = rowRef.current;
    if (!row) return undefined;
    const measure = () => {
      const controls = [...(controlsRef.current?.children || []), ...(extraRef.current?.children || [])];
      setFits(controlsFit({
        available: row.clientWidth,
        controlsWidth: oneLineWidth(controls.map(c => c.offsetWidth), gap),
        titleWidth: titleRef.current?.scrollWidth,
        columnGap,
      }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    for (const el of [row, controlsRef.current, extraRef.current]) if (el) observer.observe(el);
    return () => observer.disconnect();
  }, [enabled, fits, gap, columnGap]);

  return { rowRef, titleRef, controlsRef, extraRef, fits };
}

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

// Sort's text label can be hidden (ListSortMenu iconOnly), so a control's one-line width is
// taken as if its label showed: the hidden label stays rendered, invisible and out of the flow,
// so its width is known in either state. Otherwise hiding the label would shrink the very width
// that decided to hide it, and the header would flip back and forth.
function sortLabel(control) {
  return control.querySelector?.('[data-sort-label]') || null;
}
function labelGap(label) {
  return parseFloat(getComputedStyle(label.parentElement).columnGap) || 0;
}
// The control's width with its label showing (Sort keeps its 220px cap).
function labeledWidth(control) {
  const label = sortLabel(control);
  if (!label || !label.hasAttribute('data-hidden')) return control.offsetWidth;
  const cap = parseFloat(getComputedStyle(label.parentElement).maxWidth);
  const width = control.offsetWidth + labelGap(label) + label.offsetWidth;
  return Number.isFinite(cap) ? Math.min(cap, width) : width;
}
// The control's width with its label hidden.
function iconOnlyWidth(control) {
  const label = sortLabel(control);
  if (!label || label.hasAttribute('data-hidden')) return control.offsetWidth;
  return control.offsetWidth - labelGap(label) - label.offsetWidth;
}

// Whether Sort should drop its label: only when the row does not fit with it and does without.
// Otherwise the label stays.
export function sortIconOnly({ available, labeled, iconOnly }) {
  if (!(available > 0)) return false;
  return labeled > available && iconOnly <= available;
}

// Whether the second row should break evenly, two controls per line: when it has four controls
// and does not fit even with Sort as an icon. Wrapping on its own would leave the last control
// alone on a third line.
export function breakEvenly({ available, iconOnly, count }) {
  if (!(available > 0)) return false;
  return count >= 4 && iconOnly > available;
}

// The controls of a row, without the even-break marker (zero height, full width).
function controlsOf(el) {
  return [...(el?.children || [])].filter(c => !c.hasAttribute('data-row-break'));
}

// rowRef: the title row. titleRef: the title, which must not grow (flex-grow 0), so its
// scrollWidth is its own width rather than the space left over. controlsRef: the controls next to
// the title. extraRef: the second row of the two-row form. Both forms render the same controls,
// only split across one or two rows, so their one-line width is the same either way: switching
// forms cannot change the answer, and the header does not flicker. Measuring in both forms keeps
// the answer current when the count, the folder or the labels change.
//
// enabled: whether the one-row form is possible at all (not in the narrow layouts, which always
// show the two-row form).
// sortIconOnly: whether Sort in the second row shows only its icon (ListSortMenu iconOnly).
// secondRowBreak: whether the second row breaks after its second control (breakEvenly).
export function useHeaderControlsFit(enabled, { gap, columnGap }) {
  const rowRef = useRef(null);
  const titleRef = useRef(null);
  const controlsRef = useRef(null);
  const extraRef = useRef(null);
  const [fits, setFits] = useState(true);
  const [iconOnly, setIconOnly] = useState(false);
  const [evenBreak, setEvenBreak] = useState(false);

  useLayoutEffect(() => {
    const row = rowRef.current;
    // The second row, when the two-row form shows (always in the narrow layouts).
    const extra = !enabled || !fits ? extraRef.current : null;
    const measure = () => {
      const top = controlsOf(controlsRef.current);
      const below = controlsOf(extra);
      setFits(!enabled || !row || controlsFit({
        available: row.clientWidth,
        controlsWidth: oneLineWidth([...top, ...below].map(labeledWidth), gap),
        titleWidth: titleRef.current?.scrollWidth,
        columnGap,
      }));
      const second = {
        available: extra?.clientWidth,
        labeled: oneLineWidth(below.map(labeledWidth), gap),
        iconOnly: oneLineWidth(below.map(iconOnlyWidth), gap),
        count: below.length,
      };
      setIconOnly(!!extra && sortIconOnly(second));
      setEvenBreak(!!extra && breakEvenly(second));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    // The label too: its width changes with the chosen order while the row's own size may not.
    const labels = [...(controlsRef.current?.querySelectorAll('[data-sort-label]') || []), ...(extra?.querySelectorAll('[data-sort-label]') || [])];
    // And the title, whose width follows its text: another folder's name of the same row width.
    for (const el of [row, titleRef.current, controlsRef.current, extra, ...labels]) if (el) observer.observe(el);
    return () => observer.disconnect();
  }, [enabled, fits, iconOnly, evenBreak, gap, columnGap]);

  return { rowRef, titleRef, controlsRef, extraRef, fits, sortIconOnly: iconOnly, secondRowBreak: evenBreak };
}

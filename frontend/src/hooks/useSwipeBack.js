// The back swipe on a phone (#229): right from the left edge of the screen returns to the list.
// A home-screen app on iOS has no swipe-back of its own. Swiping between messages is native
// scrolling (components/SwipePager.jsx); this is the edge only.
//
// It listens in MailFlow's own page, on the pane, and never inside an email frame: WebKit runs no
// listener inside a sandboxed frame without scripts. Over the email, the edge is SwipePager's strip
// ([data-swipe-edge]), which sits above the frame; elsewhere (the top bar) it is the first EDGE px.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export const EDGE = 16; // px from the left edge of the screen where a back swipe starts
export const DECIDE = 10; // px moved before the gesture is read as sideways or not
export const RATIO = 1.5; // sideways: at least this much more across than up or down
export const BACK_COMMIT = 80; // px right that goes back to the list

// 'h' once a gesture has moved DECIDE px mostly across, 'v' once it has moved that far otherwise,
// null before then.
export function swipeAxis(dx, dy) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < DECIDE && ay < DECIDE) return null;
  return ax > ay * RATIO ? 'h' : 'v';
}

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

// Whether a touch at page x on `target` starts a back swipe.
export function startsBackSwipe(target, x) {
  if (!target?.closest || target.closest(EDITABLE)) return false;
  if (target.closest('[data-swipe-edge]')) return true;
  return x <= EDGE && !target.closest('[data-swipe-pager]');
}

const resetStyles = (el) => {
  if (!el) return;
  el.style.transition = '';
  el.style.transform = '';
};

// rootRef: the pane, which follows the finger and slides away. navKey: what is open, to put the
// pane back in place when it changes (the pane can stay mounted while hidden). onBack: to the list.
export function useSwipeBack({ enabled, rootRef, navKey, onBack }) {
  const latest = useRef({});
  latest.current = { onBack };
  const timers = useRef(new Set());

  // The pane element itself, not only the ref: a pane renders a different element before
  // anything is open (or while loading). Checked after every render; it only sets state when the
  // element differs, so it settles after one more render.
  const [root, setRoot] = useState(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (rootRef.current !== root) setRoot(rootRef.current);
  });

  useLayoutEffect(() => {
    if (enabled) resetStyles(rootRef.current);
  }, [enabled, navKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!enabled || !root) return undefined;
    const pending = timers.current;
    const later = (fn, ms) => {
      const id = setTimeout(() => { pending.delete(id); fn(); }, ms);
      pending.add(id);
    };
    let g = null;

    const onStart = (e) => {
      g = null;
      if (e.touches.length !== 1) return;
      if ((window.visualViewport?.scale ?? 1) > 1.01) return;
      const t = e.touches[0];
      if (!startsBackSwipe(e.target, t.clientX)) return;
      g = { x: t.clientX, y: t.clientY, axis: null, dx: 0 };
    };
    const onMove = (e) => {
      if (!g) return;
      if (e.touches.length !== 1) { cancel(); return; }
      const t = e.touches[0];
      const dx = t.clientX - g.x;
      const dy = t.clientY - g.y;
      if (!g.axis) {
        g.axis = swipeAxis(dx, dy);
        if (g.axis === 'h' && dx < 0) g.axis = 'v'; // leftward from the edge is not ours
      }
      if (g.axis !== 'h') return;
      e.preventDefault();
      g.dx = Math.max(0, dx);
      root.style.transition = 'none';
      root.style.transform = `translateX(${g.dx}px)`;
    };
    const springBack = () => {
      root.style.transition = 'transform 0.22s ease';
      root.style.transform = 'translateX(0)';
      later(() => resetStyles(root), 240);
    };
    const onEnd = (e) => {
      const gesture = g;
      g = null;
      if (!gesture || gesture.axis !== 'h') return;
      // A swipe is not a tap: no click on what it started on (after going back, the list is
      // under the finger, and the click would open a row).
      e.preventDefault();
      if (gesture.dx <= BACK_COMMIT) { springBack(); return; }
      root.style.transition = 'transform 0.22s ease';
      root.style.transform = `translateX(${window.innerWidth}px)`;
      later(() => { latest.current.onBack(); later(() => resetStyles(root), 400); }, 220);
    };
    const cancel = () => {
      const gesture = g;
      g = null;
      if (gesture?.axis === 'h') springBack();
    };

    root.addEventListener('touchstart', onStart, { passive: true });
    root.addEventListener('touchmove', onMove, { passive: false });
    root.addEventListener('touchend', onEnd, { passive: false });
    root.addEventListener('touchcancel', cancel, { passive: true });
    return () => {
      root.removeEventListener('touchstart', onStart);
      root.removeEventListener('touchmove', onMove);
      root.removeEventListener('touchend', onEnd);
      root.removeEventListener('touchcancel', cancel);
      for (const id of pending) clearTimeout(id);
      pending.clear();
      resetStyles(root);
    };
  }, [enabled, root]);
}

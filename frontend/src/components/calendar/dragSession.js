// Follows the pointer after a press until it is released, calling onMove once it has travelled
// past the threshold (a press that stays put is a click, not a drag). Escape cancels.
export function dragSession(start, { onMove, onEnd, threshold = 4 }) {
  const x0 = start.clientX;
  const y0 = start.clientY;
  let moved = false;
  const stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', key, true);
  };
  const move = (e) => {
    if (!moved && Math.hypot(e.clientX - x0, e.clientY - y0) < threshold) return;
    moved = true;
    onMove(e);
  };
  const up = (e) => { stop(); onEnd(e, moved, false); };
  const cancel = (e) => { stop(); onEnd(e, moved, true); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(e); } };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', key, true);
  return stop;
}

// Only a mouse or pen press drags; a touch scrolls instead.
export const canDrag = (e, occ) => !occ.readOnly && e.button === 0 && e.pointerType !== 'touch';

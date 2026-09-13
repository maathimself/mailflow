import { useCallback, useLayoutEffect, useRef } from 'react';

// Generic draggable / resizable in-app window frame (#219). The message-window
// feature renders a MessagePane inside one of these. The drag/resize technique
// mirrors ComposeModal: pointer capture + direct DOM mutation during the gesture
// (no React re-render per pointermove), committing the final rect on pointerup.
//
// Position/size are owned by the caller (the store, via rect + onCommitRect). This
// component never holds rect in local state, so multiple windows stay in sync with
// the store and survive re-renders cleanly.
const MIN_W = 380;
const MIN_H = 280;

export default function FloatingWindow({
  rect,                // { x, y, w, h }
  zIndex,
  title,
  accentColor,
  onFocus,
  onCommitRect,        // ({ x, y, w, h }) => void
  onMinimize,
  onClose,
  minimizeLabel = 'Minimize',
  closeLabel = 'Close',
  children,
}) {
  const elRef = useRef(null);
  const gestureCleanupRef = useRef(null);
  const gestureActiveRef = useRef(false);

  // Geometry (left/top/width/height) is applied imperatively rather than through the
  // style prop so that an unrelated re-render (a background sync, another window gaining
  // focus) never clobbers the DOM position mid-gesture. While a drag/resize is active the
  // gesture owns the DOM and this effect stands down; on commit, rect updates and this
  // re-syncs to the same pixels already in place. Runs pre-paint, so there is no flash.
  useLayoutEffect(() => {
    if (gestureActiveRef.current) return;
    const el = elRef.current;
    if (!el) return;
    el.style.left = rect.x + 'px';
    el.style.top = rect.y + 'px';
    el.style.width = rect.w + 'px';
    el.style.height = rect.h + 'px';
  }, [rect.x, rect.y, rect.w, rect.h]);

  const beginTitleDrag = useCallback((e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, a, input, select')) return;
    e.preventDefault();
    const el = elRef.current;
    if (!el) return;
    gestureCleanupRef.current?.({ commit: false });
    const captureEl = e.currentTarget;
    const pointerId = e.pointerId;
    captureEl.setPointerCapture(pointerId);
    gestureActiveRef.current = true;
    const startRect = el.getBoundingClientRect();
    const startMouseX = e.clientX;
    const startMouseY = e.clientY;
    const w = startRect.width;
    const h = startRect.height;
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    let curX = startRect.left;
    let curY = startRect.top;
    const onMove = (ev) => {
      curX = Math.max(0, Math.min(window.innerWidth - w, startRect.left + ev.clientX - startMouseX));
      curY = Math.max(0, Math.min(Math.max(0, window.innerHeight - h), startRect.top + ev.clientY - startMouseY));
      el.style.left = curX + 'px';
      el.style.top = curY + 'px';
    };
    const cleanup = ({ commit = true } = {}) => {
      captureEl.removeEventListener('pointermove', onMove);
      captureEl.removeEventListener('pointerup', onUp);
      captureEl.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
      if (captureEl.hasPointerCapture?.(pointerId)) captureEl.releasePointerCapture(pointerId);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      gestureActiveRef.current = false;
      gestureCleanupRef.current = null;
      if (commit) onCommitRect?.({ x: curX, y: curY, w, h });
    };
    const onUp = () => cleanup({ commit: true });
    const onCancel = () => cleanup({ commit: false });
    gestureCleanupRef.current = cleanup;
    captureEl.addEventListener('pointermove', onMove);
    captureEl.addEventListener('pointerup', onUp);
    captureEl.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onCancel);
  }, [onCommitRect]);

  const beginResize = useCallback((e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = elRef.current;
    if (!el) return;
    gestureCleanupRef.current?.({ commit: false });
    const captureEl = e.currentTarget;
    const pointerId = e.pointerId;
    captureEl.setPointerCapture(pointerId);
    gestureActiveRef.current = true;
    const startRect = el.getBoundingClientRect();
    const startMouseX = e.clientX;
    const startMouseY = e.clientY;
    const x = startRect.left;
    const y = startRect.top;
    document.body.style.cursor = 'nwse-resize';
    document.body.style.userSelect = 'none';
    let curW = startRect.width;
    let curH = startRect.height;
    const onMove = (ev) => {
      curW = Math.min(window.innerWidth - x - 4, Math.max(MIN_W, startRect.width + ev.clientX - startMouseX));
      curH = Math.min(window.innerHeight - y - 4, Math.max(MIN_H, startRect.height + ev.clientY - startMouseY));
      el.style.width = curW + 'px';
      el.style.height = curH + 'px';
    };
    const cleanup = ({ commit = true } = {}) => {
      captureEl.removeEventListener('pointermove', onMove);
      captureEl.removeEventListener('pointerup', onUp);
      captureEl.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
      if (captureEl.hasPointerCapture?.(pointerId)) captureEl.releasePointerCapture(pointerId);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      gestureActiveRef.current = false;
      gestureCleanupRef.current = null;
      if (commit) onCommitRect?.({ x, y, w: curW, h: curH });
    };
    const onUp = () => cleanup({ commit: true });
    const onCancel = () => cleanup({ commit: false });
    gestureCleanupRef.current = cleanup;
    captureEl.addEventListener('pointermove', onMove);
    captureEl.addEventListener('pointerup', onUp);
    captureEl.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onCancel);
  }, [onCommitRect]);

  return (
    <div
      ref={elRef}
      className="mailexpert-window"
      onPointerDownCapture={onFocus}
      style={{
        // left/top/width/height are applied imperatively (see layout effect above) so
        // background re-renders can't reset the window's position/size mid-gesture.
        position: 'fixed',
        zIndex,
        display: 'flex', flexDirection: 'column',
        background: 'var(--bg-primary)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 12,
        boxShadow: 'var(--shadow-modal, 0 12px 40px rgba(0,0,0,0.35))',
        overflow: 'hidden',
      }}
    >
      {/* Title bar — drag handle */}
      <div
        className="mailexpert-window-titlebar"
        onPointerDown={beginTitleDrag}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 8px 8px 12px', flexShrink: 0,
          background: 'var(--bg-secondary)',
          borderBottom: '1px solid var(--border-subtle)',
          cursor: 'grab', touchAction: 'none', userSelect: 'none',
        }}
      >
        <span style={{
          width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
          background: accentColor || 'var(--accent)',
        }} />
        <div style={{
          flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600,
          color: 'var(--text-primary)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {title}
        </div>
        <button
          type="button"
          onClick={onMinimize}
          title={minimizeLabel}
          aria-label={minimizeLabel}
          className="mailexpert-window-btn"
          style={winBtnStyle}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="5" y1="19" x2="19" y2="19" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onClose}
          title={closeLabel}
          aria-label={closeLabel}
          className="mailexpert-window-btn"
          style={winBtnStyle}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Content — MessagePane fills this */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {children}
      </div>

      {/* Bottom-right resize handle */}
      <div
        onPointerDown={beginResize}
        title=""
        style={{
          position: 'absolute', right: 0, bottom: 0, width: 18, height: 18,
          cursor: 'nwse-resize', touchAction: 'none', zIndex: 2,
        }}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" style={{ position: 'absolute', right: 1, bottom: 1, opacity: 0.5 }}>
          <path d="M16 8 L8 16 M16 13 L13 16" stroke="var(--text-tertiary)" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
}

const winBtnStyle = {
  width: 26, height: 26, flexShrink: 0,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'transparent', border: 'none', borderRadius: 6,
  color: 'var(--text-secondary)', cursor: 'pointer',
};

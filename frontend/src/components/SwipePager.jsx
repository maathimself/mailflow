import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { senderColor } from '../themes.js';

// Swiping between messages on a phone (#229), as native horizontal scrolling: the reading
// content sits on the middle page of a pager, between a peek at the previous message in the list
// and one at the next, and settling on a peek opens that message.
//
// Scrolling, not touch listeners, because the email body is a sandboxed frame without scripts,
// and WebKit (every browser on iOS) runs no event listener inside such a frame, not even one
// MailFlow's own page registered: a gesture listening there never hears the finger. A sideways
// pan over a frame that cannot scroll sideways is handed to the scroller around it by the browser
// itself, in every engine, and links, text selection, vertical scrolling and an email's own
// sideways-scrolling parts all keep working as they did.
//
// The left edge strip belongs to the back swipe (hooks/useSwipeBack.js): it sits over the
// frame, so a touch there stays in MailFlow's page.

// How long a pager resting a pixel or two off a page edge waits before that counts as landed.
const SETTLE_MS = 80;

// The peek is the next message's own header card, as the reading pane draws it (subject, avatar,
// sender), with placeholder lines for the body: the swipe brings the next email in, not a screen
// about it, and its body fills in where the reader is already looking.
function Peek({ row, side }) {
  const { t } = useTranslation();
  const name = row.from_name || row.from_email || '?';
  const subject = row.subject && row.subject !== '(no subject)' ? row.subject : t('message.noSubject');
  const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
  return (
    <div aria-hidden="true" data-swipe-peek={side} style={{
      flex: '0 0 100%', scrollSnapAlign: 'start', boxSizing: 'border-box', overflow: 'hidden',
      padding: '12px 0 0', background: 'var(--bg-primary)',
    }}>
      <div style={{
        marginBottom: 12, background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-subtle)',
        borderLeft: row.account_color ? `3px solid ${row.account_color}` : undefined,
      }}>
        <div style={{
          padding: '14px 16px 12px', borderBottom: '1px solid var(--border-subtle)',
          fontSize: 17, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.3, fontFamily: 'var(--font-display)',
        }}>
          {subject}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px' }}>
          <div style={{
            width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
            background: senderColor(row.from_email || row.from_name),
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 16, fontWeight: 700, color: 'white',
          }}>
            {name[0].toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', ...ellipsis }}>{name}</div>
            {row.from_name && <div style={{ fontSize: 12, color: 'var(--text-tertiary)', ...ellipsis }}>{row.from_email}</div>}
          </div>
        </div>
      </div>
      <div style={{ padding: '4px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {[92, 100, 84, 97, 62].map((w, i) => (
          <div key={i} className="skeleton-line" style={{ height: 12, width: `${w}%`, borderRadius: 4 }} />
        ))}
      </div>
    </div>
  );
}

// enabled: phones only; elsewhere the children render as they always have. prev/next: the rows
// either side, or null at an end of the list. navKey: what is open, to put the pager back on the
// middle page once the next one shows. onNavigate(dir) opens 'prev' or 'next', true if it did.
// onPrefetch(row) loads a neighbor's body ahead, so a swipe lands on a message that is ready.
export default function SwipePager({ enabled, prev, next, navKey, onNavigate, onPrefetch, children }) {
  const pagerRef = useRef(null);
  const [zoomed, setZoomed] = useState(false);
  const recentering = useRef(false);
  const navigating = useRef(false);
  const latest = useRef({});
  latest.current = { onNavigate, hasPrev: Boolean(prev) };

  // The current page, without animating: the peek the reader landed on is replaced by the message.
  const recentre = useCallback(() => {
    const el = pagerRef.current;
    if (!el) return;
    recentering.current = true;
    el.scrollLeft = latest.current.hasPrev ? el.clientWidth : 0;
    requestAnimationFrame(() => { recentering.current = false; });
  }, []);

  useLayoutEffect(() => {
    if (!enabled) return;
    navigating.current = false;
    recentre();
  }, [enabled, navKey, Boolean(prev), recentre]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!enabled) return;
    if (prev) onPrefetch?.(prev);
    if (next) onPrefetch?.(next);
  }, [enabled, prev?.id, next?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!enabled) return undefined;
    const el = pagerRef.current;
    if (!el) return undefined;
    let timer = null;
    let frame = 0;
    // Opens the neighbor the pager has come to rest on. `slack` px off a page edge still counts.
    const settle = (slack) => {
      timer = null;
      if (recentering.current || navigating.current) return;
      const w = el.clientWidth;
      if (!w) return;
      const page = Math.round(el.scrollLeft / w);
      if (Math.abs(el.scrollLeft - page * w) > slack) return; // between pages: still moving
      const current = latest.current.hasPrev ? 1 : 0;
      if (page === current) return;
      navigating.current = true;
      if (!latest.current.onNavigate(page < current ? 'prev' : 'next')) {
        navigating.current = false;
        el.scrollTo({ left: current * w, behavior: 'smooth' });
      }
    };
    // The moment the snap lands exactly on a neighbor, open it (checked once more on the next
    // frame, so a finger passing over the edge does not count); scrollend, where a browser has it,
    // or a short quiet spell catches a landing a pixel or two off.
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => settle(0.5));
      clearTimeout(timer);
      timer = setTimeout(() => settle(2), SETTLE_MS);
    };
    const onScrollEnd = () => { clearTimeout(timer); settle(2); };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('scrollend', onScrollEnd);
    // A rotation or a resize keeps the reader on the message, not between pages.
    const Observer = el.ownerDocument.defaultView.ResizeObserver;
    const ro = Observer ? new Observer(() => recentre()) : null;
    ro?.observe(el);
    // Panning a pinch-zoomed page must not turn it.
    const vv = el.ownerDocument.defaultView.visualViewport;
    const onZoom = () => setZoomed((vv?.scale ?? 1) > 1.01);
    vv?.addEventListener('resize', onZoom);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('scrollend', onScrollEnd);
      ro?.disconnect();
      vv?.removeEventListener('resize', onZoom);
    };
  }, [enabled, recentre]);

  if (!enabled) return children;
  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, minWidth: 0, display: 'flex' }}>
      <div
        ref={pagerRef}
        data-swipe-pager=""
        className="swipe-pager"
        style={{
          flex: 1, minWidth: 0, display: 'flex',
          overflowX: zoomed ? 'hidden' : 'auto', overflowY: 'hidden',
          scrollSnapType: 'x mandatory', overscrollBehaviorX: 'contain',
        }}
      >
        {prev && <Peek row={prev} side="prev" />}
        <div style={{
          flex: '0 0 100%', minWidth: 0, display: 'flex', flexDirection: 'column',
          scrollSnapAlign: 'start', scrollSnapStop: 'always',
        }}>
          {children}
        </div>
        {next && <Peek row={next} side="next" />}
      </div>
      {/* The back swipe's edge: over the frame, so its touches stay in MailFlow's page. */}
      <div data-swipe-edge="" aria-hidden="true" style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: 16, zIndex: 2, touchAction: 'pan-y',
      }} />
    </div>
  );
}

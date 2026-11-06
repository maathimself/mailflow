import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  addDays, dayKey, formatClock, formatDayText, formatHour, hiddenCounts, layoutColumns, layoutWeek,
  minutesOnDay, occursOnDay, parseDay, shiftOccurrence, slotToDate, snapMinutes, compareOccurrences, SNAP_MINUTES,
} from '../../utils/calendarDates.js';
import { tint } from './calendarUi.jsx';
import { canDrag, dragSession } from './dragSession.js';

const ALL_DAY_LANES = 3;
const LANE = 21;

const MOBILE_COLUMN = 76;
const minutesFromY = (rect, y, hourHeight) => Math.max(0, Math.min(1440, ((y - rect.top) / hourHeight) * 60));

export default function TimeGridView({
  days, today, events, colorOf, isMobile, locale, active,
  onOpen, onCreate, onOpenDay, onPreview, onMove,
}) {
  const { t } = useTranslation();
  // Taller screens get taller hours, so a working day fills them.
  const hourHeight = isMobile ? 48 : Math.max(52, Math.min(72, Math.round(window.innerHeight / 14)));
  const gutter = isMobile ? 40 : 56;
  const n = days.length;
  const scrollRef = useRef(null);
  const bodyRef = useRef(null);
  const suppressClick = useRef(false);
  const lastPointer = useRef('mouse');
  const [now, setNow] = useState(() => new Date());
  const [selection, setSelection] = useState(null);
  const [allDayOpen, setAllDayOpen] = useState(false);

  useEffect(() => {
    if (!active) return undefined;
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, [active]);

  useEffect(() => {
    if (!active || !scrollRef.current) return;
    const nowHour = new Date().getHours();
    const startHour = days.includes(dayKey(new Date())) && (nowHour < 7 || nowHour > 18) ? Math.max(0, nowHour - 1) : 7;
    scrollRef.current.scrollTop = startHour * hourHeight;
    const todayColumn = days.indexOf(dayKey(new Date()));
    if (isMobile && n > 1) scrollRef.current.scrollLeft = Math.max(0, todayColumn) * MOBILE_COLUMN;
    // Scrolls on opening and when the number of columns changes, not on every date step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, n, hourHeight]);

  const allDay = layoutWeek(events.filter(e => e.allDay), days);
  const hiddenAllDay = allDayOpen ? [] : hiddenCounts(allDay.segments, n, ALL_DAY_LANES);
  const shownLanes = allDayOpen ? allDay.laneCount : Math.min(allDay.laneCount, ALL_DAY_LANES);
  const timed = events.filter(e => !e.allDay);

  const columnIndex = (x) => {
    const rect = bodyRef.current.getBoundingClientRect();
    return Math.min(n - 1, Math.max(0, Math.floor(((x - rect.left) / rect.width) * n)));
  };

  const beginEventDrag = (e, occ, resize) => {
    if (!canDrag(e, occ)) return;
    e.stopPropagation();
    const y0 = e.clientY;
    const col0 = columnIndex(e.clientX);
    const times = (ev) => shiftOccurrence(occ, {
      days: resize ? 0 : columnIndex(ev.clientX) - col0,
      minutes: snapMinutes(((ev.clientY - y0) / hourHeight) * 60),
      resize,
    });
    const same = (a) => a.start === new Date(occ.start).toISOString() && a.end === new Date(occ.end).toISOString();
    dragSession(e, {
      onMove: (ev) => { const next = times(ev); onPreview(occ, same(next) ? null : next); },
      onEnd: (ev, moved, cancelled) => {
        if (!moved) return;
        suppressClick.current = true;
        setTimeout(() => { suppressClick.current = false; }, 0);
        const next = times(ev);
        if (cancelled || same(next)) onPreview(null);
        else onMove(occ, next);
      },
    });
  };

  const createTimed = (day, a, b) => {
    onCreate({ allDay: false, start: slotToDate(day, a).toISOString(), end: slotToDate(day, b).toISOString() });
  };

  const beginSelect = (e, day, idx) => {
    lastPointer.current = e.pointerType;
    if (e.pointerType === 'touch' || e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const anchorMin = Math.floor(minutesFromY(rect, e.clientY, hourHeight) / SNAP_MINUTES) * SNAP_MINUTES;
    const range = (ev) => {
      const m = Math.floor(minutesFromY(rect, ev.clientY, hourHeight) / SNAP_MINUTES) * SNAP_MINUTES;
      return [Math.min(anchorMin, m), Math.min(1440, Math.max(anchorMin, m) + SNAP_MINUTES)];
    };
    dragSession(e, {
      onMove: (ev) => { const [a, b] = range(ev); setSelection({ idx, a, b }); },
      onEnd: (ev, moved, cancelled) => {
        setSelection(null);
        suppressClick.current = true;
        setTimeout(() => { suppressClick.current = false; }, 0);
        if (cancelled) return;
        if (moved) { const [a, b] = range(ev); createTimed(day, a, b); }
        else createTimed(day, Math.min(anchorMin, 1380), Math.min(anchorMin, 1380) + 60);
      },
    });
  };

  const tapCreate = (e, day) => {
    if (suppressClick.current || lastPointer.current === 'mouse' || lastPointer.current === 'pen') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const start = Math.min(1380, Math.floor(minutesFromY(rect, e.clientY, hourHeight) / 30) * 30);
    createTimed(day, start, start + 60);
  };

  const todayIdx = days.indexOf(today);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const nowTop = (nowMin / 60) * hourHeight;
  const cols = `${gutter}px repeat(${n}, minmax(0, 1fr))`;
  const minWidth = isMobile && n > 1 ? gutter + n * MOBILE_COLUMN : undefined;

  return (
    <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', position: 'relative', minHeight: 0 }}>
      <div style={{ minWidth, position: 'relative' }}>
        <div style={{ position: 'sticky', top: 0, zIndex: 6, background: 'var(--bg-primary)', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: cols }}>
            <div style={{ position: 'sticky', left: 0, zIndex: 1, background: 'var(--bg-primary)' }} />
            {days.map(day => {
              const isToday = day === today;
              const head = (
                <>
                  <span style={{ fontSize: 11.5, color: isToday ? 'var(--accent)' : 'var(--text-tertiary)', fontWeight: 500 }}>
                    {formatDayText(day, { weekday: 'short' }, locale)}
                  </span>
                  <span style={{
                    fontSize: 18, fontWeight: isToday ? 600 : 500, fontVariantNumeric: 'tabular-nums', lineHeight: '28px',
                    minWidth: 28, height: 28, borderRadius: 14, padding: '0 4px', boxSizing: 'border-box',
                    background: isToday ? 'var(--accent)' : 'transparent',
                    color: isToday ? 'var(--accent-text)' : 'var(--text-primary)',
                  }}>{parseDay(day).d}</span>
                </>
              );
              const style = { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, padding: '6px 0 4px', background: 'none', border: 'none', fontFamily: 'inherit' };
              return onOpenDay && n > 1 ? (
                <button key={day} type="button" onClick={() => onOpenDay(day)} style={{ ...style, cursor: 'pointer' }}
                  aria-label={formatDayText(day, { weekday: 'long', day: 'numeric', month: 'long' }, locale)}>{head}</button>
              ) : <div key={day} style={style}>{head}</div>;
            })}
          </div>

          <div style={{
            display: 'grid', gridTemplateColumns: cols, position: 'relative', borderTop: '1px solid var(--border-subtle)',
            gridTemplateRows: `repeat(${Math.max(1, shownLanes)}, ${LANE}px) ${hiddenAllDay.some(c => c > 0) || (allDayOpen && allDay.laneCount > ALL_DAY_LANES) ? '18px' : '4px'}`,
          }}>
            <div style={{ gridColumn: 1, gridRow: '1 / -1', fontSize: 9.5, lineHeight: 1.1, color: 'var(--text-tertiary)', padding: '3px 6px 0 0', textAlign: 'right', overflow: 'hidden', position: 'sticky', left: 0, zIndex: 3, background: 'var(--bg-primary)' }}>
              {!isMobile && t('calendar.allDay')}
            </div>
            {days.map((day, i) => (
              <div key={day} onClick={() => onCreate({ allDay: true, start: day, end: addDays(day, 1) })}
                style={{ gridColumn: i + 2, gridRow: '1 / -1', borderLeft: '1px solid var(--border-subtle)', cursor: 'pointer' }} />
            ))}
            {allDay.segments.filter(s => allDayOpen || s.lane < ALL_DAY_LANES).map(seg => {
              const { occ } = seg;
              const color = colorOf(occ.calendarId);
              return (
                <button key={occ.id} type="button" title={occ.summary} aria-label={occ.summary}
                  onClick={(e) => { if (!suppressClick.current) onOpen(occ, e.currentTarget); }}
                  onPointerDown={(e) => {
                    if (!canDrag(e, occ)) return;
                    const rect = bodyRef.current.getBoundingClientRect();
                    const colAt = (x) => Math.min(n - 1, Math.max(0, Math.floor(((x - rect.left) / rect.width) * n)));
                    const c0 = colAt(e.clientX);
                    dragSession(e, {
                      onMove: (ev) => { const d = colAt(ev.clientX) - c0; onPreview(occ, d ? shiftOccurrence(occ, { days: d }) : null); },
                      onEnd: (ev, moved, cancelled) => {
                        if (!moved) return;
                        suppressClick.current = true;
                        setTimeout(() => { suppressClick.current = false; }, 0);
                        const d = colAt(ev.clientX) - c0;
                        if (cancelled || !d) onPreview(null);
                        else onMove(occ, shiftOccurrence(occ, { days: d }));
                      },
                    });
                  }}
                  style={{
                    gridColumn: `${seg.startCol + 2} / ${seg.endCol + 2}`, gridRow: seg.lane + 1, zIndex: 2,
                    margin: `1px ${seg.after ? 0 : 3}px 1px ${seg.before ? 0 : 3}px`, padding: '0 6px',
                    display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left',
                    fontSize: 11.5, fontWeight: 500, fontFamily: 'inherit', color: 'var(--text-primary)', border: 'none',
                    background: tint(color, 30), cursor: occ.readOnly ? 'pointer' : 'grab',
                    borderRadius: `${seg.before ? 0 : 4}px ${seg.after ? 0 : 4}px ${seg.after ? 0 : 4}px ${seg.before ? 0 : 4}px`,
                  }}>
                  {occ.summary || t('common.noSubject')}
                </button>
              );
            })}
            {hiddenAllDay.map((c, i) => c > 0 && (
              <button key={`m${i}`} type="button" onClick={() => setAllDayOpen(true)} style={{
                gridColumn: i + 2, gridRow: ALL_DAY_LANES + 1, zIndex: 2, justifySelf: 'start', margin: '0 3px', padding: '0 4px',
                border: 'none', background: 'transparent', color: 'var(--text-secondary)', fontSize: 11, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
              }}>{t('calendar.more', { count: c })}</button>
            ))}
            {allDayOpen && allDay.laneCount > ALL_DAY_LANES && (
              <button type="button" onClick={() => setAllDayOpen(false)} style={{
                gridColumn: 1, gridRow: shownLanes + 1, zIndex: 2, justifySelf: 'end', padding: '0 6px 0 0', border: 'none',
                background: 'transparent', color: 'var(--text-secondary)', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit',
              }}>{t('calendar.showLess')}</button>
            )}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: cols, position: 'relative', height: 24 * hourHeight }}>
          <div style={{ position: 'sticky', left: 0, zIndex: 4, background: 'var(--bg-primary)' }}>
            {Array.from({ length: 23 }, (_, i) => i + 1).map(h => (
              <div key={h} style={{
                position: 'absolute', top: h * hourHeight - 7, right: 8, fontSize: 10.5, lineHeight: '14px',
                color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
              }}>{formatHour(h, locale)}</div>
            ))}
          </div>
          <div ref={bodyRef} style={{ gridColumn: `2 / ${n + 2}`, display: 'grid', gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))`, position: 'relative' }}>
            {days.map((day, i) => {
              const items = timed.filter(o => occursOnDay(o, day)).map(o => ({ occ: o, ...minutesOnDay(o, day) }));
              const layout = layoutColumns(items.map(it => ({ id: it.occ.id, startMin: it.startMin, endMin: it.endMin })));
              items.sort((a, b) => compareOccurrences(a.occ, b.occ));
              return (
                <div key={day}
                  onPointerDown={(e) => { if (e.target === e.currentTarget) beginSelect(e, day, i); else lastPointer.current = e.pointerType; }}
                  onClick={(e) => { if (e.target === e.currentTarget) tapCreate(e, day); }}
                  style={{
                    position: 'relative', borderLeft: '1px solid var(--border-subtle)', cursor: 'default', touchAction: 'pan-y',
                    background: day === today ? 'color-mix(in srgb, var(--accent-glow) 40%, transparent)' : 'transparent',
                    backgroundImage: `repeating-linear-gradient(to bottom, var(--border-subtle) 0, var(--border-subtle) 1px, transparent 1px, transparent ${hourHeight}px)`,
                  }}>
                  {selection && selection.idx === i && (
                    <div style={{
                      position: 'absolute', left: 2, right: 2, top: (selection.a / 60) * hourHeight, height: ((selection.b - selection.a) / 60) * hourHeight,
                      background: 'var(--accent-dim)', border: '1px solid var(--accent)', borderRadius: 5, pointerEvents: 'none', zIndex: 3,
                    }} />
                  )}
                  {items.map(({ occ, startMin, endMin }) => {
                    const pos = layout.get(occ.id) || { col: 0, cols: 1 };
                    const top = (startMin / 60) * hourHeight;
                    const height = Math.max(18, ((Math.max(endMin, startMin + SNAP_MINUTES) - startMin) / 60) * hourHeight - 1);
                    const color = colorOf(occ.calendarId);
                    const endsHere = dayKey(new Date(occ.end)) === day || new Date(occ.end).getTime() <= new Date(occ.start).getTime();
                    const cancelled = occ.status === 'CANCELLED';
                    return (
                      <button key={occ.id} type="button"
                        aria-label={`${occ.summary}, ${formatClock(occ.start, locale)}`}
                        onPointerDown={(e) => beginEventDrag(e, occ, false)}
                        onClick={(e) => { if (!suppressClick.current) onOpen(occ, e.currentTarget); }}
                        style={{
                          position: 'absolute', top, height, zIndex: 2,
                          left: `calc(${(pos.col / pos.cols) * 100}% + 2px)`, width: `calc(${100 / pos.cols}% - 4px)`,
                          boxSizing: 'border-box', padding: '2px 6px', textAlign: 'left', overflow: 'hidden',
                          border: 'none', borderRadius: 5, fontFamily: 'inherit', color: 'var(--text-primary)',
                          background: tint(color, 30), boxShadow: '0 0 0 1px var(--bg-primary)',
                          cursor: occ.readOnly ? 'pointer' : 'grab', opacity: cancelled ? 0.55 : 1,
                          textDecoration: cancelled ? 'line-through' : 'none',
                        }}>
                        <div style={{ fontSize: 12, fontWeight: 600, lineHeight: '15px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: height < 34 ? 'nowrap' : 'normal' }}>
                          {occ.summary || t('common.noSubject')}
                        </div>
                        {height >= 34 && (
                          <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: '14px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {formatClock(occ.start, locale)} – {formatClock(occ.end, locale)}
                          </div>
                        )}
                        {height >= 56 && occ.location && (
                          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{occ.location}</div>
                        )}
                        {!occ.readOnly && endsHere && (
                          <div onPointerDown={(e) => beginEventDrag(e, occ, true)} aria-hidden="true"
                            style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 7, cursor: 'ns-resize' }} />
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {todayIdx >= 0 && (
            <div aria-hidden="true" style={{ position: 'absolute', left: 0, right: 0, top: nowTop, height: 0, zIndex: 4, pointerEvents: 'none' }}>
              <div style={{
                position: 'absolute', left: 2, width: gutter - 8, top: -9, height: 18, borderRadius: 9, background: 'var(--red)',
                color: 'white', fontSize: 10.5, fontWeight: 600, lineHeight: '18px', textAlign: 'center', fontVariantNumeric: 'tabular-nums',
              }}>{formatClock(now, locale)}</div>
              <div style={{ position: 'absolute', left: gutter, right: 0, top: -1, height: 2, background: 'var(--red)', opacity: 0.25 }} />
              <div style={{
                position: 'absolute', top: -1, height: 2, background: 'var(--red)',
                left: `calc(${gutter}px + (100% - ${gutter}px) * ${todayIdx / n})`, width: `calc((100% - ${gutter}px) / ${n})`,
              }} />
              <div style={{
                position: 'absolute', top: -4, width: 8, height: 8, borderRadius: '50%', background: 'var(--red)',
                left: `calc(${gutter}px + (100% - ${gutter}px) * ${todayIdx / n} - 4px)`,
              }} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

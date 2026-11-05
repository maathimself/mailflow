import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  formatClock, formatDayText, hiddenCounts, layoutWeek, parseDay, shiftOccurrence,
} from '../../utils/calendarDates.js';
import { tint } from './calendarUi.jsx';
import { canDrag, dragSession } from './dragSession.js';

export default function MonthView({
  weeks, anchor, today, events, colorOf, isMobile, locale,
  onOpen, onCreate, onOpenDay, onPreview, onMove,
}) {
  const { t } = useTranslation();
  const gridRef = useRef(null);
  const suppressClick = useRef(false);
  const maxLanes = isMobile ? 2 : 3;
  const lane = isMobile ? 17 : 20;
  const month = parseDay(anchor).m;

  const cellAt = (e) => {
    const rect = gridRef.current.getBoundingClientRect();
    const col = Math.min(6, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * 7)));
    const row = Math.min(weeks.length - 1, Math.max(0, Math.floor(((e.clientY - rect.top) / rect.height) * weeks.length)));
    return row * 7 + col;
  };

  const beginDrag = (e, occ) => {
    if (!canDrag(e, occ)) return;
    const grabbed = cellAt(e);
    dragSession(e, {
      onMove: (ev) => {
        const days = cellAt(ev) - grabbed;
        onPreview(occ, days ? shiftOccurrence(occ, { days }) : null);
      },
      onEnd: (ev, moved, cancelled) => {
        if (!moved) return;
        suppressClick.current = true;
        setTimeout(() => { suppressClick.current = false; }, 0);
        const days = cellAt(ev) - grabbed;
        if (cancelled || !days) onPreview(null);
        else onMove(occ, shiftOccurrence(occ, { days }));
      },
    });
  };

  const days7 = weeks[0];
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', flexShrink: 0, borderBottom: '1px solid var(--border-subtle)' }}>
        {days7.map(d => (
          <div key={d} style={{ padding: '7px 8px', fontSize: 12, color: 'var(--text-tertiary)', fontWeight: 500, textAlign: isMobile ? 'center' : 'left' }}>
            {formatDayText(d, { weekday: isMobile ? 'narrow' : 'short' }, locale)}
          </div>
        ))}
      </div>
      <div ref={gridRef} style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden auto' }}>
        {weeks.map((days, w) => {
          const { segments } = layoutWeek(events, days);
          const hidden = hiddenCounts(segments, 7, maxLanes);
          return (
            <div key={days[0]} style={{
              flex: '1 0 auto', minHeight: 26 + maxLanes * lane + 20, display: 'grid',
              gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
              gridTemplateRows: `26px repeat(${maxLanes}, ${lane}px) 18px 1fr`,
            }}>
              {days.map((day, i) => {
                const outside = parseDay(day).m !== month;
                const isToday = day === today;
                return (
                  <div key={day} style={{ display: 'contents' }}>
                    <div
                      onClick={() => (isMobile ? onOpenDay(day) : onCreate(day))}
                      style={{
                        gridColumn: i + 1, gridRow: `1 / ${maxLanes + 4}`, cursor: 'pointer',
                        borderRight: i < 6 ? '1px solid var(--border-subtle)' : 'none',
                        borderBottom: w < weeks.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                        background: outside ? 'var(--bg-secondary)' : 'transparent',
                      }} />
                    <div style={{ gridColumn: i + 1, gridRow: 1, display: 'flex', justifyContent: isMobile ? 'center' : 'flex-start', padding: '3px 6px 0', pointerEvents: 'none', zIndex: 1 }}>
                      <button type="button" onClick={() => onOpenDay(day)}
                        aria-label={formatDayText(day, { weekday: 'long', day: 'numeric', month: 'long' }, locale)}
                        style={{
                          pointerEvents: 'auto', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                          minWidth: 22, height: 22, padding: '0 5px', borderRadius: 11, fontSize: 12,
                          fontVariantNumeric: 'tabular-nums', fontWeight: isToday ? 600 : 500,
                          background: isToday ? 'var(--accent)' : 'transparent',
                          color: isToday ? 'var(--accent-text)' : outside ? 'var(--text-tertiary)' : 'var(--text-primary)',
                        }}>
                        {parseDay(day).d === 1 && !isMobile ? formatDayText(day, { day: 'numeric', month: 'short' }, locale) : parseDay(day).d}
                      </button>
                    </div>
                  </div>
                );
              })}
              {segments.filter(s => s.lane < maxLanes).map(seg => {
                const { occ } = seg;
                const color = colorOf(occ.calendarId);
                const bar = occ.allDay || seg.endCol - seg.startCol > 1 || seg.before || seg.after;
                const timeText = !occ.allDay && !isMobile ? `${formatClock(occ.start, locale)} ` : '';
                const cancelled = occ.status === 'CANCELLED';
                return (
                  <button
                    key={`${occ.id}:${w}`}
                    type="button"
                    onPointerDown={(e) => beginDrag(e, occ)}
                    onClick={(e) => { if (!suppressClick.current) onOpen(occ, e.currentTarget); }}
                    aria-label={occ.summary}
                    title={occ.summary}
                    style={{
                      gridColumn: `${seg.startCol + 1} / ${seg.endCol + 1}`, gridRow: seg.lane + 2, zIndex: 2,
                      margin: `1px ${seg.after ? 0 : 3}px 1px ${seg.before ? 0 : 3}px`,
                      display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, overflow: 'hidden',
                      padding: '0 6px', fontFamily: 'inherit', fontSize: isMobile ? 10.5 : 11.5, lineHeight: 1,
                      border: 'none', cursor: occ.readOnly ? 'pointer' : 'grab', textAlign: 'left',
                      color: 'var(--text-primary)', opacity: cancelled ? 0.55 : 1,
                      textDecoration: cancelled ? 'line-through' : 'none',
                      background: bar ? tint(color, 26) : 'transparent',
                      boxShadow: bar && !seg.before ? `inset 3px 0 0 ${color}` : 'none',
                      paddingLeft: bar && !seg.before ? 8 : 4,
                      borderRadius: `${seg.before ? 0 : 4}px ${seg.after ? 0 : 4}px ${seg.after ? 0 : 4}px ${seg.before ? 0 : 4}px`,
                    }}
                    onMouseEnter={e => { if (!bar) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                    onMouseLeave={e => { if (!bar) e.currentTarget.style.background = 'transparent'; }}
                  >
                    {!bar && <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />}
                    {seg.before && <span aria-hidden="true" style={{ color: 'var(--text-tertiary)' }}>‹</span>}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: bar ? 500 : 400, minWidth: 0 }}>
                      {!bar && <span style={{ color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{timeText}</span>}
                      {occ.summary || t('common.noSubject')}
                    </span>
                  </button>
                );
              })}
              {hidden.map((n, i) => n > 0 && (
                <button
                  key={`more${days[i]}`}
                  type="button"
                  onClick={() => onOpenDay(days[i])}
                  style={{
                    gridColumn: i + 1, gridRow: maxLanes + 2, zIndex: 2, justifySelf: 'start', margin: '0 3px',
                    border: 'none', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer',
                    fontSize: 11, padding: '0 4px', borderRadius: 4, fontFamily: 'inherit', fontWeight: 500,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  {t('calendar.more', { count: n })}
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

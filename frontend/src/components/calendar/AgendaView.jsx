import { useTranslation } from 'react-i18next';
import { addDays, compareOccurrences, dayKey, formatClock, formatDayText, occursOnDay, parseDay } from '../../utils/calendarDates.js';
import { tint } from './calendarUi.jsx';

export default function AgendaView({ days, today, events, colorOf, calendarName, locale, loading, onOpen, onCreate }) {
  const { t } = useTranslation();
  const groups = days
    .map(day => ({ day, items: events.filter(e => occursOnDay(e, day)).sort(compareOccurrences) }))
    .filter(g => g.items.length || g.day === today);
  const empty = groups.every(g => !g.items.length);

  return (
    <div style={{ flex: 1, overflow: 'hidden auto', minHeight: 0 }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '8px 0 96px' }}>
        {groups.map(({ day, items }) => {
          const isToday = day === today;
          return (
            <section key={day} aria-label={formatDayText(day, { weekday: 'long', day: 'numeric', month: 'long' }, locale)}
              style={{ display: 'flex', gap: 14, padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
              <div style={{ width: 52, flexShrink: 0, textAlign: 'center', paddingTop: 2 }}>
                <div style={{ fontSize: 11.5, fontWeight: 500, color: isToday ? 'var(--accent)' : 'var(--text-tertiary)' }}>
                  {formatDayText(day, { weekday: 'short' }, locale)}
                </div>
                <div style={{
                  margin: '2px auto 0', width: 34, height: 34, borderRadius: 17, lineHeight: '34px', fontSize: 18,
                  fontWeight: isToday ? 600 : 500, fontVariantNumeric: 'tabular-nums',
                  background: isToday ? 'var(--accent)' : 'transparent', color: isToday ? 'var(--accent-text)' : 'var(--text-primary)',
                }}>{parseDay(day).d}</div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
                  {formatDayText(day, { month: 'short' }, locale)}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
                {items.length === 0 && (
                  <button type="button" onClick={() => onCreate({ allDay: true, start: day, end: addDays(day, 1) })} style={{
                    textAlign: 'left', padding: '10px 4px', border: 'none', background: 'none', color: 'var(--text-tertiary)',
                    fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
                  }}>{t('calendar.nothingToday')}</button>
                )}
                {items.map(occ => {
                  const color = colorOf(occ.calendarId);
                  const cancelled = occ.status === 'CANCELLED';
                  return (
                    <button key={`${day}:${occ.id}`} type="button" onClick={(e) => onOpen(occ, e.currentTarget)}
                      style={{
                        display: 'flex', alignItems: 'stretch', gap: 12, padding: '8px 12px 8px 0', textAlign: 'left', cursor: 'pointer',
                        border: 'none', borderRadius: 8, fontFamily: 'inherit', color: 'var(--text-primary)',
                        background: tint(color, 14), boxShadow: `inset 4px 0 0 ${color}`, paddingLeft: 16,
                        opacity: cancelled ? 0.55 : 1, textDecoration: cancelled ? 'line-through' : 'none',
                      }}>
                      <span style={{ width: 84, flexShrink: 0, fontSize: 12, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', paddingTop: 1 }}>
                        {occ.allDay ? t('calendar.allDay') : (
                          <>
                            {dayKey(new Date(occ.start)) === day ? formatClock(occ.start, locale) : '…'}
                            <br />
                            <span style={{ color: 'var(--text-tertiary)' }}>{formatClock(occ.end, locale)}</span>
                          </>
                        )}
                      </span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {occ.summary || t('common.noSubject')}
                        </span>
                        <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {[occ.location, calendarName(occ.calendarId)].filter(Boolean).join(', ')}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
        {empty && !loading && (
          <p style={{ textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13, margin: '32px 16px' }}>{t('calendar.agendaEmpty')}</p>
        )}
      </div>
    </div>
  );
}

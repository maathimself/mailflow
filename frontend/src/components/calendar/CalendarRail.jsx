import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  addMonths, dateFromDay, formatDayText, monthGrid, monthStart, parseDay, weekDays,
  dayDiff,
} from '../../utils/calendarDates.js';
import { Btn, Icon, IconBtn, PALETTE } from './calendarUi.jsx';

function MiniMonth({ anchor, today, firstDay, locale, rangeFirst, rangeEnd, onPick }) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(monthStart(anchor));
  useEffect(() => { setShown(monthStart(anchor)); }, [anchor]);
  const weeks = monthGrid(shown, firstDay);
  const month = parseDay(shown).m;
  return (
    <div style={{ padding: '4px 4px 8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '0 2px 4px' }}>
        <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
          {formatDayText(shown, { month: 'long', year: 'numeric' }, locale)}
        </span>
        <IconBtn label={t('calendar.previous')} icon="chevL" size={24} iconSize={14} onClick={() => setShown(addMonths(shown, -1))} />
        <IconBtn label={t('calendar.next')} icon="chevR" size={24} iconSize={14} onClick={() => setShown(addMonths(shown, 1))} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', textAlign: 'center' }}>
        {weekDays(weeks[0][0], firstDay).map(d => (
          <span key={d} style={{ fontSize: 10.5, color: 'var(--text-tertiary)', padding: '2px 0' }}>{formatDayText(d, { weekday: 'narrow' }, locale)}</span>
        ))}
        {weeks.flat().map(day => {
          const isToday = day === today;
          const inRange = day >= rangeFirst && day < rangeEnd && dayDiff(rangeFirst, rangeEnd) < 28;
          return (
            <button key={day} type="button" onClick={() => onPick(day)}
              aria-label={dateFromDay(day).toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
              aria-current={isToday ? 'date' : undefined}
              style={{
                height: 26, border: 'none', cursor: 'pointer', fontSize: 11.5, fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums',
                borderRadius: isToday ? 13 : 6, margin: isToday ? '0 auto' : 0, width: isToday ? 26 : 'auto',
                fontWeight: isToday ? 600 : 400,
                background: isToday ? 'var(--accent)' : inRange ? 'var(--bg-hover)' : 'transparent',
                color: isToday ? 'var(--accent-text)' : parseDay(day).m === month ? 'var(--text-primary)' : 'var(--text-tertiary)',
              }}>{parseDay(day).d}</button>
          );
        })}
      </div>
    </div>
  );
}

function Check({ checked, color }) {
  return (
    <span aria-hidden="true" style={{
      width: 16, height: 16, borderRadius: 4, flexShrink: 0, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center',
      border: `1.5px solid ${color}`, background: checked ? color : 'transparent',
    }}>
      {checked && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
      )}
    </span>
  );
}

function CalendarRow({ cal, onToggle, onColor, roomy }) {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(false);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, borderRadius: 7 }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
        <button type="button" role="checkbox" aria-checked={cal.visible} onClick={() => onToggle(cal)} style={{
          flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 9, padding: roomy ? '11px 6px' : '6px 6px', border: 'none', background: 'none',
          cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, color: cal.visible ? 'var(--text-primary)' : 'var(--text-tertiary)', textAlign: 'left',
        }}>
          <Check checked={cal.visible} color={cal.color} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cal.name}</span>
          {cal.readOnly && <Icon name="lock" size={12} style={{ color: 'var(--text-tertiary)' }} />}
        </button>
        <button type="button" onClick={() => setPicking(p => !p)} aria-expanded={picking} aria-label={t('calendar.rail.color', { name: cal.name })}
          title={t('calendar.rail.color', { name: cal.name })} style={{
            width: 24, height: 24, border: 'none', background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, padding: 0,
          }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: cal.color, boxShadow: picking ? '0 0 0 2px var(--bg-secondary), 0 0 0 3.5px var(--text-tertiary)' : 'none' }} />
        </button>
      </div>
      {picking && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '4px 6px 8px 31px', alignItems: 'center' }}>
          {PALETTE.map(c => (
            <button key={c} type="button" onClick={() => { onColor(cal, c); setPicking(false); }} aria-label={c}
              style={{ width: 18, height: 18, borderRadius: '50%', background: c, cursor: 'pointer', padding: 0,
                border: c.toLowerCase() === cal.color.toLowerCase() ? '2px solid var(--text-primary)' : '2px solid transparent' }} />
          ))}
          <input type="color" value={/^#[0-9a-f]{6}$/i.test(cal.color) ? cal.color : '#7c6af7'} aria-label={t('calendar.rail.customColor')}
            onChange={e => onColor(cal, e.target.value)}
            style={{ width: 22, height: 22, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }} />
        </div>
      )}
    </div>
  );
}

export default function CalendarRail({
  anchor, today, firstDay, locale, range, calendars, onPick, onToggle, onColor, onNew, onAddAccount, onManage, compact, sidebar, collapsed,
}) {
  const { t } = useTranslation();
  // Same place, size and look as the sidebar's Compose button, which this one stands in for.
  const newButton = sidebar && (
    <div style={{ padding: '12px 10px', flexShrink: 0 }}>
      <button type="button" onClick={onNew} className="btn-press" aria-label={t('calendar.newEvent')} title={collapsed ? t('calendar.newEvent') : undefined} style={{
        width: '100%', padding: collapsed ? '10px' : '10px 14px', background: 'var(--accent)', border: 'none', borderRadius: 8,
        color: 'var(--accent-text)', fontSize: 13, fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer', display: 'flex', alignItems: 'center',
        justifyContent: collapsed ? 'center' : 'flex-start', gap: 8,
      }}>
        <Icon name="plus" size={15} />
        {!collapsed && t('calendar.newEvent')}
      </button>
    </div>
  );
  if (collapsed) {
    return (
      <>
        {newButton}
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '4px 0' }}>
          {calendars.map(cal => (
            <button key={cal.id} type="button" onClick={() => onToggle(cal)} title={cal.name} aria-label={cal.name} aria-pressed={cal.visible} style={{
              width: 32, height: 32, flexShrink: 0, border: 'none', background: 'none', cursor: 'pointer', borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
            }}>
              <Check checked={cal.visible} color={cal.color} />
            </button>
          ))}
          <span style={{ flex: 1 }} />
          <IconBtn label={t('calendar.rail.manage')} icon="gear" size={32} iconSize={15} onClick={onManage} />
        </div>
      </>
    );
  }
  const groups = [];
  for (const cal of calendars) {
    let g = groups.find(x => x.id === cal.accountId);
    if (!g) { g = { id: cal.accountId, name: cal.accountName, items: [] }; groups.push(g); }
    g.items.push(cal);
  }
  return (
    <>
    {newButton}
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: compact ? '0 4px 8px' : sidebar ? '2px 10px 10px' : '14px 12px', minHeight: 0, overflow: 'hidden auto', flex: 1 }}>
      {!compact && !sidebar && (
        <Btn kind="primary" onClick={onNew} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px 12px', fontSize: 13 }}>
          <Icon name="plus" size={14} /> {t('calendar.newEvent')}
        </Btn>
      )}
      <MiniMonth anchor={anchor} today={today} firstDay={firstDay} locale={locale} rangeFirst={range.first} rangeEnd={range.endDay} onPick={onPick} />
      <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {groups.map(g => (
          <div key={g.id}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', padding: '0 6px 2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name}</div>
            {g.items.map(cal => <CalendarRow key={cal.id} cal={cal} onToggle={onToggle} onColor={onColor} roomy={compact} />)}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 6 }}>
        <Btn kind="plain" onClick={onAddAccount} style={{ display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', fontSize: 13 }}>
          <Icon name="plus" size={14} /> {t('calendar.rail.addAccount')}
        </Btn>
        <Btn kind="plain" onClick={onManage} style={{ display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', fontSize: 13 }}>
          <Icon name="gear" size={14} /> {t('calendar.rail.manage')}
        </Btn>
      </div>
    </div>
    </>
  );
}

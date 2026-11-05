import { useTranslation } from 'react-i18next';
import { VIEWS } from '../../utils/calendarDates.js';
import { Btn, IconBtn } from './calendarUi.jsx';

const VIEW_KEYS = {
  month: 'calendar.views.month',
  week: 'calendar.views.week',
  day: 'calendar.views.day',
  agenda: 'calendar.views.agenda',
};

function Segmented({ view, onView, compact }) {
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={t('calendar.views.label')} style={{ display: 'flex', background: 'var(--bg-tertiary)', borderRadius: 8, padding: 2, gap: 2 }}>
      {VIEWS.map(v => (
        <button key={v} type="button" aria-pressed={view === v} onClick={() => onView(v)} style={{
          border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: compact ? 12 : 12.5, fontWeight: 500,
          padding: compact ? '8px 2px' : '5px 12px', borderRadius: 6, flex: compact ? 1 : 'none', minWidth: 0, whiteSpace: 'nowrap',
          background: view === v ? 'var(--bg-elevated)' : 'transparent',
          color: view === v ? 'var(--text-primary)' : 'var(--text-secondary)',
          boxShadow: view === v ? 'var(--shadow-soft)' : 'none',
        }}>{t(VIEW_KEYS[v])}</button>
      ))}
    </div>
  );
}

export default function CalendarToolbar({ title, view, onView, onToday, onPrev, onNext, isMobile, busy, onRail, onBack }) {
  const { t } = useTranslation();
  const nav = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <Btn onClick={onToday} style={{ marginRight: 4 }}>{t('calendar.today')}</Btn>
      <IconBtn label={t('calendar.previous')} icon="chevL" onClick={onPrev} size={isMobile ? 36 : 30} />
      <IconBtn label={t('calendar.next')} icon="chevR" onClick={onNext} size={isMobile ? 36 : 30} />
    </div>
  );
  const heading = (
    <h1 aria-live="polite" style={{
      margin: 0, fontSize: isMobile ? 16 : 19, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--text-primary)',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: isMobile ? 1 : '1 1 170px',
    }}>{title}</h1>
  );
  const status = busy ? <span role="status" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('common.saving')}</span> : null;

  if (isMobile) {
    // Everything on two rows that fit a 320 px phone: no control is ever pushed off the edge.
    return (
      <div style={{ flexShrink: 0, padding: 'calc(var(--sat) + 4px) 8px 8px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
          <IconBtn label={t('common.back')} icon="chevL" onClick={onBack} size={36} iconSize={20} />
          {heading}
          {status}
          <IconBtn label={t('calendar.today')} icon="today" onClick={onToday} size={36} iconSize={18} />
          <IconBtn label={t('calendar.previous')} icon="chevL" onClick={onPrev} size={36} />
          <IconBtn label={t('calendar.next')} icon="chevR" onClick={onNext} size={36} />
          <IconBtn label={t('calendar.calendars')} icon="list" onClick={onRail} size={36} iconSize={18} />
        </div>
        <Segmented view={view} onView={onView} compact />
      </div>
    );
  }
  return (
    <div style={{ flexShrink: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 16px', padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
      {nav}
      {heading}
      {status}
      <Segmented view={view} onView={onView} />
    </div>
  );
}

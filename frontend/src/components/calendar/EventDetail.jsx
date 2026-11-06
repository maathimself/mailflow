import { useLayoutEffect, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatWhen } from '../../utils/calendarDates.js';
import { ATTENDEE_KEYS, linkify, recurrenceText, reminderText } from './calendarEvents.js';
import { Btn, ErrorBox, Icon, IconBtn, Modal } from './calendarUi.jsx';

const WIDTH = 340;

function Row({ icon, children }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', fontSize: 13, lineHeight: 1.45, color: 'var(--text-primary)' }}>
      <Icon name={icon} size={15} style={{ color: 'var(--text-tertiary)', marginTop: 2 }} />
      <div style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{children}</div>
    </div>
  );
}

// Plain text; http(s) addresses become links, nothing else is ever parsed as markup.
function PlainText({ text }) {
  return (
    <div style={{ whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto' }}>
      {linkify(text).map((p, i) => p.href
        ? <a key={i} href={p.href} target="_blank" rel="noopener noreferrer nofollow" style={{ color: 'var(--accent)' }}>{p.text}</a>
        : <span key={i}>{p.text}</span>)}
    </div>
  );
}

function Body({ occ, calendar, color, locale, busy, error, onEdit, onDelete, onClose }) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const recurrence = occ.isRecurring ? recurrenceText(occ, t, locale) : '';
  const attendees = occ.attendees || [];
  const statusKey = occ.status === 'TENTATIVE' ? 'calendar.status.tentative' : occ.status === 'CANCELLED' ? 'calendar.status.cancelled' : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <span aria-hidden="true" style={{ width: 12, height: 12, borderRadius: 4, background: color, marginTop: 5, flexShrink: 0 }} />
        <h3 style={{ flex: 1, margin: 0, fontSize: 17, fontWeight: 600, lineHeight: 1.3, color: 'var(--text-primary)', wordBreak: 'break-word' }}>
          {occ.summary || t('common.noSubject')}
        </h3>
        <IconBtn label={t('common.dismiss')} icon="close" onClick={onClose} size={26} iconSize={14} style={{ margin: '-3px -4px 0 0' }} />
      </div>
      {statusKey && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: -6, paddingLeft: 22 }}>{t(statusKey)}</div>}
      <Row icon="clock">{formatWhen(occ, locale)}</Row>
      {recurrence && <Row icon="repeat">{recurrence}</Row>}
      {occ.location && <Row icon="pin">{occ.location}</Row>}
      {occ.reminderMinutes != null && <Row icon="bell">{reminderText(occ.reminderMinutes, t)}</Row>}
      {occ.organizer && (occ.organizer.name || occ.organizer.email) && (
        <Row icon="users">
          <span style={{ color: 'var(--text-tertiary)' }}>{t('calendar.detail.organizer')} </span>
          {occ.organizer.name || occ.organizer.email}
          {occ.organizer.name && occ.organizer.email && <span style={{ color: 'var(--text-tertiary)' }}> {occ.organizer.email}</span>}
        </Row>
      )}
      {attendees.length > 0 && (
        <Row icon="users">
          <div style={{ color: 'var(--text-tertiary)', marginBottom: 2 }}>{t('calendar.detail.attendees', { n: attendees.length })}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 130, overflow: 'auto' }}>
            {attendees.map((a, i) => (
              <div key={`${a.email}:${i}`} style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name || a.email}</span>
                {ATTENDEE_KEYS[a.status] && <span style={{ color: 'var(--text-tertiary)', flexShrink: 0, fontSize: 12 }}>{t(ATTENDEE_KEYS[a.status])}</span>}
              </div>
            ))}
          </div>
        </Row>
      )}
      {occ.url && /^https?:\/\//i.test(occ.url) && (
        <Row icon="note"><a href={occ.url} target="_blank" rel="noopener noreferrer nofollow" style={{ color: 'var(--accent)' }}>{occ.url}</a></Row>
      )}
      {occ.description && <Row icon="note"><PlainText text={occ.description} /></Row>}
      <Row icon="calendar">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
          {calendar ? `${calendar.name}${calendar.accountName ? ` (${calendar.accountName})` : ''}` : ''}
        </span>
      </Row>
      {error && <ErrorBox>{error}</ErrorBox>}
      {occ.readOnly ? (
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', display: 'flex', gap: 6, alignItems: 'center' }}>
          <Icon name="lock" size={12} /> {t('calendar.detail.readOnly')}
        </div>
      ) : confirming ? (
        <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--red-dim, rgba(248,113,113,0.1))', border: '1px solid var(--red-border, rgba(248,113,113,0.3))' }}>
          <div style={{ fontSize: 13, marginBottom: 10, color: 'var(--text-primary)' }}>{t('calendar.detail.deleteConfirm')}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn kind="solidDanger" disabled={busy} onClick={() => onDelete(occ)}>{busy ? t('common.deleting') : t('common.delete')}</Btn>
            <Btn onClick={() => setConfirming(false)}>{t('common.cancel')}</Btn>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn kind="danger" disabled={busy} onClick={() => (occ.isRecurring ? onDelete(occ) : setConfirming(true))}>{t('common.delete')}</Btn>
          <Btn kind="primary" disabled={busy} onClick={() => onEdit(occ)}>{t('common.edit')}</Btn>
        </div>
      )}
    </div>
  );
}

export default function EventDetail({ occ, rect, isMobile, onClose, ...rest }) {
  const { t } = useTranslation();
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: 0, top: 0, ready: false });

  useLayoutEffect(() => {
    if (isMobile || !ref.current) return;
    const h = ref.current.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = rect ? rect.right + 8 : (vw - WIDTH) / 2;
    if (rect && left + WIDTH > vw - 8) left = rect.left - WIDTH - 8;
    if (left < 8) left = Math.max(8, Math.min(vw - WIDTH - 8, (rect ? rect.left : 0)));
    let top = rect ? rect.top : (vh - h) / 2;
    top = Math.max(8, Math.min(top, vh - h - 8));
    setPos({ left, top, ready: true });
  }, [isMobile, rect, occ.id]);

  useEffect(() => {
    if (isMobile) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [isMobile, onClose]);

  if (isMobile) {
    return <Modal mobile label={occ.summary || t('calendar.detail.label')} onClose={onClose}><Body occ={occ} onClose={onClose} {...rest} /></Modal>;
  }
  return (
    <div ref={ref} role="dialog" aria-label={occ.summary || t('calendar.detail.label')} style={{
      position: 'fixed', left: pos.left, top: pos.top, width: WIDTH, maxHeight: 'calc(100vh - 16px)', overflow: 'hidden auto',
      zIndex: 8000, padding: 16, boxSizing: 'border-box', borderRadius: 12, background: 'var(--bg-elevated)',
      border: '1px solid var(--border)', boxShadow: 'var(--shadow-popover)', visibility: pos.ready ? 'visible' : 'hidden',
      animation: pos.ready ? 'popover-in var(--motion-fast) var(--ease-emphasized) both' : 'none',
    }}>
      <Body occ={occ} onClose={onClose} {...rest} />
    </div>
  );
}

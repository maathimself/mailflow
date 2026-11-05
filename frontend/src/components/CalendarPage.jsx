import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { useStore } from '../store/index.js';
import { useMobile } from '../hooks/useMobile.js';
import { appLocale } from '../utils/formatDate.js';
import {
  AGENDA_DAYS, VIEWS, addDays, firstDayOfWeek, formatTitle, monthGrid, shiftAnchor, todayDay, visibleRange, weekDays,
} from '../utils/calendarDates.js';
import { describeError, defaultSlot, movePayload, withScope } from './calendar/calendarEvents.js';
import { useCalendarData } from './calendar/useCalendarData.js';
import { Btn, ErrorBox, Icon, Modal } from './calendar/calendarUi.jsx';
import CalendarToolbar from './calendar/CalendarToolbar.jsx';
import CalendarRail from './calendar/CalendarRail.jsx';
import MonthView from './calendar/MonthView.jsx';
import TimeGridView from './calendar/TimeGridView.jsx';
import AgendaView from './calendar/AgendaView.jsx';
import EventDetail from './calendar/EventDetail.jsx';
import EventForm from './calendar/EventForm.jsx';
import ScopeDialog from './calendar/ScopeDialog.jsx';
import AccountsModal from './calendar/AccountsModal.jsx';

const VIEW_STORAGE_KEY = 'mailflow:calendar:view';

function storedView() {
  try {
    const v = localStorage.getItem(VIEW_STORAGE_KEY);
    return VIEWS.includes(v) ? v : null;
  } catch { return null; }
}

function EmptyState({ onConnect }) {
  const { t } = useTranslation();
  const chips = [['#4f8df7', '58%', 0], ['#e5548c', '78%', 1], ['#3fb97f', '44%', 2]];
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32, overflow: 'auto' }}>
      <div style={{ maxWidth: 400, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <div aria-hidden="true" style={{
          width: 176, padding: '10px 10px 12px', borderRadius: 12, border: '1px solid var(--border)', background: 'var(--bg-secondary)',
          boxShadow: 'var(--shadow-soft)', display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8,
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 3 }}>
            {Array.from({ length: 7 }, (_, i) => <span key={i} style={{ height: 3, borderRadius: 2, background: i === 3 ? 'var(--accent)' : 'var(--border)' }} />)}
          </div>
          {chips.map(([color, width, i]) => (
            <div key={color} style={{ height: 14, width, marginLeft: `${i * 14}%`, borderRadius: 4, background: `color-mix(in srgb, ${color} 30%, var(--bg-secondary))`, boxShadow: `inset 3px 0 0 ${color}` }} />
          ))}
        </div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: 'var(--text-primary)' }}>{t('calendar.empty.title')}</h2>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: 'var(--text-secondary)' }}>{t('calendar.empty.body')}</p>
        <Btn kind="primary" onClick={onConnect} style={{ padding: '9px 18px', fontSize: 14, marginTop: 4 }}>{t('calendar.empty.connect')}</Btn>
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>{t('calendar.accounts.googleHint')}</p>
      </div>
    </div>
  );
}

function CalendarShell({ active }) {
  const { t } = useTranslation();
  const setShowCalendar = useStore(s => s.setShowCalendar);
  const isMobile = useMobile();
  const locale = appLocale();
  const firstDay = firstDayOfWeek(locale);

  const [view, setViewState] = useState(() => storedView() || (isMobile ? 'agenda' : 'week'));
  const [anchor, setAnchor] = useState(() => todayDay());
  const [today, setToday] = useState(() => todayDay());
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(0);
  const [preview, setPreview] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [form, setForm] = useState(null);
  const [scopeAsk, setScopeAsk] = useState(null);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);

  const range = useMemo(() => visibleRange(view, anchor, firstDay), [view, anchor, firstDay]);
  const data = useCalendarData({ active, from: range.from, to: range.to });
  const { accounts, calendars, setCalendars, events, error: loadError, refresh, loadEvents, loadMeta } = data;

  useEffect(() => {
    if (!active) return undefined;
    setToday(todayDay());
    const timer = setInterval(() => setToday(todayDay()), 60_000);
    return () => clearInterval(timer);
  }, [active]);

  const byId = useMemo(() => new Map(calendars.map(c => [c.id, c])), [calendars]);
  const colorOf = useCallback((id) => byId.get(id)?.color || 'var(--accent)', [byId]);
  const calendarName = useCallback((id) => byId.get(id)?.name || '', [byId]);
  const hasWritable = calendars.some(c => !c.readOnly);

  const shown = useMemo(() => events
    .filter(e => byId.get(e.calendarId)?.visible !== false)
    .map(e => (preview && preview.id === e.id ? { ...e, start: preview.start, end: preview.end } : e)), [events, byId, preview]);

  const formatError = useCallback((err) => {
    const d = describeError(err);
    return t(d.key, { message: d.message });
  }, [t]);

  const report = useCallback((err) => {
    setNotice(formatError(err));
    if (describeError(err).refetch) refresh();
  }, [formatError, refresh]);

  const track = useCallback(async (fn) => {
    setBusy(b => b + 1);
    try { return await fn(); } finally { setBusy(b => b - 1); }
  }, []);

  const setView = (v) => {
    setViewState(v);
    try { localStorage.setItem(VIEW_STORAGE_KEY, v); } catch { /* the view is just not remembered */ }
  };

  const closeDetail = useCallback(() => { setDetail(null); setDetailError(null); }, []);

  const openDetail = (occ, el) => {
    const r = el.getBoundingClientRect();
    setDetailError(null);
    setDetail({ occ, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } });
  };

  const openForm = (occ, scope, defaults) => { setForm({ occ, scope, defaults, key: Date.now() }); closeDetail(); };

  const create = (slot) => {
    if (!hasWritable) { setNotice(t('calendar.errors.noWritable')); return; }
    openForm(null, 'all', slot);
  };
  const createNew = () => {
    const day = today >= range.first && today < range.endDay ? today : anchor;
    create(defaultSlot(day));
  };
  const createOnDay = (day) => create({ allDay: true, start: day, end: addDays(day, 1) });

  const requestEdit = (occ) => (occ.isRecurring ? (closeDetail(), setScopeAsk({ kind: 'edit', occ })) : openForm(occ, 'all'));

  const deleteOcc = async (occ, scope) => {
    setDetailError(null);
    try {
      await track(async () => {
        await api.calendar.deleteEvent(occ.eventId, { scope, recurrenceId: scope === 'this' ? occ.recurrenceId : undefined });
        closeDetail();
        await loadEvents();
      });
    } catch (err) {
      setDetailError(formatError(err));
      if (describeError(err).refetch) refresh();
    }
  };
  const requestDelete = (occ) => (occ.isRecurring ? setScopeAsk({ kind: 'delete', occ }) : deleteOcc(occ, 'all'));

  const commitMove = async (occ, times, scope) => {
    setPreview({ id: occ.id, ...times });
    try {
      await track(async () => {
        await api.calendar.updateEvent(occ.eventId, movePayload(occ, times, scope));
        await loadEvents();
      });
    } catch (err) {
      report(err);
    } finally {
      setPreview(null);
    }
  };
  const requestMove = (occ, times) => {
    if (occ.isRecurring) { setPreview({ id: occ.id, ...times }); setScopeAsk({ kind: 'move', occ, times }); } else commitMove(occ, times, 'all');
  };

  const chooseScope = (scope) => {
    const ask = scopeAsk;
    setScopeAsk(null);
    if (ask.kind === 'edit') openForm(ask.occ, scope);
    else if (ask.kind === 'delete') deleteOcc(ask.occ, scope);
    else commitMove(ask.occ, ask.times, scope);
  };
  const cancelScope = () => { setScopeAsk(null); setPreview(null); };

  const saveEvent = async (payload) => {
    try {
      await track(async () => {
        if (form.occ) await api.calendar.updateEvent(form.occ.eventId, withScope(payload, form.occ, form.scope));
        else await api.calendar.createEvent(payload);
        setForm(null);
        await loadEvents();
      });
    } catch (err) {
      if (describeError(err).refetch) refresh();
      throw err;
    }
  };

  const toggleCalendar = async (cal) => {
    const visible = !cal.visible;
    setCalendars(cs => cs.map(c => (c.id === cal.id ? { ...c, visible } : c)));
    try {
      await api.calendar.updateCalendar(cal.id, { visible });
      loadEvents();
    } catch (err) {
      setCalendars(cs => cs.map(c => (c.id === cal.id ? { ...c, visible: cal.visible } : c)));
      report(err);
    }
  };
  const colorCalendar = async (cal, color) => {
    setCalendars(cs => cs.map(c => (c.id === cal.id ? { ...c, color } : c)));
    try {
      await api.calendar.updateCalendar(cal.id, { color });
    } catch (err) {
      setCalendars(cs => cs.map(c => (c.id === cal.id ? { ...c, color: cal.color } : c)));
      report(err);
    }
  };

  const goToday = () => setAnchor(todayDay());
  const openDay = (day) => { setAnchor(day); setView('day'); };
  const pickDay = (day) => { setAnchor(day); setRailOpen(false); };
  const onPreview = (occ, times) => setPreview(times ? { id: occ.id, ...times } : null);

  const rangeInfo = { first: range.first, endDay: range.endDay };
  const rail = (compact) => (
    <CalendarRail
      compact={compact} anchor={anchor} today={today} firstDay={firstDay} locale={locale} range={rangeInfo} calendars={calendars}
      onPick={pickDay} onToggle={toggleCalendar} onColor={colorCalendar} onNew={createNew}
      onAddAccount={() => { setRailOpen(false); setAccountsOpen(true); }} onManage={() => { setRailOpen(false); setAccountsOpen(true); }}
    />
  );

  const failed = (accounts || []).filter(a => a.lastError);
  const syncing = (accounts || []).filter(a => !a.lastSyncAt && !a.lastError);
  const noAccounts = accounts && accounts.length === 0;

  let body;
  if (accounts === null) {
    body = loadError
      ? (
        <div style={{ margin: 24, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
          <ErrorBox>{t('calendar.errors.load', { message: loadError })}</ErrorBox>
          <Btn onClick={loadMeta}>{t('common.retry')}</Btn>
        </div>
      )
      : <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>{t('common.loading')}</div>;
  } else if (noAccounts) {
    body = <EmptyState onConnect={() => setAccountsOpen(true)} />;
  } else {
    const commonProps = { today, events: shown, colorOf, locale, onOpen: openDetail };
    const dragProps = { onPreview, onMove: requestMove };
    let viewEl;
    if (view === 'month') {
      viewEl = <MonthView {...commonProps} {...dragProps} weeks={monthGrid(anchor, firstDay)} anchor={anchor} isMobile={isMobile} onCreate={createOnDay} onOpenDay={openDay} />;
    } else if (view === 'agenda') {
      viewEl = <AgendaView {...commonProps} days={Array.from({ length: AGENDA_DAYS }, (_, i) => addDays(range.first, i))} calendarName={calendarName} loading={data.eventsLoading} onCreate={create} />;
    } else {
      viewEl = <TimeGridView {...commonProps} {...dragProps} days={view === 'week' ? weekDays(anchor, firstDay) : [anchor]} isMobile={isMobile} active={active} onCreate={create} onOpenDay={openDay} />;
    }
    body = viewEl;
  }

  const hasStack = Boolean(notice || (loadError && accounts) || failed.length || syncing.length);
  const stack = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: hasStack ? '8px 16px 0' : 0, flexShrink: 0 }}>
      {notice && (
        <ErrorBox style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <span style={{ flex: 1 }}>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', textDecoration: 'underline', padding: 0 }}>{t('common.dismiss')}</button>
        </ErrorBox>
      )}
      {loadError && accounts && (
        <ErrorBox style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ flex: 1 }}>{t('calendar.errors.load', { message: loadError })}</span>
          <Btn onClick={refresh}>{t('common.retry')}</Btn>
        </ErrorBox>
      )}
      {failed.map(a => (
        <ErrorBox key={a.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <Icon name="alert" size={16} style={{ marginTop: 1 }} />
          <span style={{ flex: 1 }}><strong>{t('calendar.accounts.bannerTitle', { name: a.name || a.username })}</strong> {a.lastError}</span>
          <Btn onClick={() => setAccountsOpen(true)}>{t('calendar.accounts.manage')}</Btn>
        </ErrorBox>
      ))}
      {syncing.map(a => (
        <div key={a.id} role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-secondary)', padding: '6px 2px' }}>
          <Icon name="sync" size={13} style={{ animation: 'spin 0.8s linear infinite' }} /> {t('calendar.accounts.firstSyncBanner', { name: a.name || a.username })}
        </div>
      ))}
    </div>
  );

  return (
    <div style={{ display: 'flex', flex: 1, minWidth: 0, height: '100%', overflow: 'hidden', background: 'var(--bg-primary)', position: 'relative' }}>
      {!isMobile && (
        <aside aria-label={t('calendar.calendars')} style={{ width: 244, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', background: 'var(--bg-secondary)', minHeight: 0 }}>
          {rail(false)}
        </aside>
      )}
      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <CalendarToolbar
          title={formatTitle(view, anchor, firstDay, locale)} view={view} onView={setView} isMobile={isMobile}
          onToday={goToday} onPrev={() => setAnchor(a => shiftAnchor(view, a, -1))} onNext={() => setAnchor(a => shiftAnchor(view, a, 1))}
          busy={busy > 0} onRail={() => setRailOpen(true)} onBack={() => setShowCalendar(false)}
        />
        {stack}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>{body}</div>
      </main>

      {isMobile && accounts && accounts.length > 0 && (
        <button type="button" onClick={createNew} aria-label={t('calendar.newEvent')} style={{
          position: 'absolute', right: 20, bottom: 'calc(var(--sab) + 20px)', width: 52, height: 52, borderRadius: '50%', border: 'none',
          background: 'var(--accent)', color: 'var(--accent-text)', boxShadow: 'var(--shadow-popover)', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 20,
        }}><Icon name="plus" size={22} /></button>
      )}

      {railOpen && isMobile && (
        <Modal mobile title={t('calendar.calendars')} onClose={() => setRailOpen(false)}>{rail(true)}</Modal>
      )}
      {detail && (
        <EventDetail
          occ={detail.occ} rect={detail.rect} isMobile={isMobile} calendar={byId.get(detail.occ.calendarId)} color={colorOf(detail.occ.calendarId)}
          locale={locale} busy={busy > 0} error={detailError} onClose={closeDetail} onEdit={requestEdit} onDelete={requestDelete}
        />
      )}
      {form && (
        <EventForm
          key={form.key} occ={form.occ} scope={form.scope} defaults={form.defaults} calendars={calendars} isMobile={isMobile}
          formatError={formatError} onSave={saveEvent} onClose={() => setForm(null)}
        />
      )}
      {scopeAsk && <ScopeDialog kind={scopeAsk.kind} summary={scopeAsk.occ.summary} isMobile={isMobile} onChoose={chooseScope} onClose={cancelScope} />}
      {accountsOpen && <AccountsModal accounts={accounts} isMobile={isMobile} onClose={() => setAccountsOpen(false)} onChanged={refresh} />}
    </div>
  );
}

export default function CalendarPage() {
  const active = useStore(s => s.showCalendar);
  const [opened, setOpened] = useState(active);
  useEffect(() => { if (active) setOpened(true); }, [active]);
  if (!opened) return null;
  return <CalendarShell active={active} />;
}

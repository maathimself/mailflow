import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { useMobile } from '../hooks/useMobile.js';
import { LAYOUTS } from '../layouts.js';
import AccountMark from './AccountMark.jsx';
import UndoBar from './UndoBar.jsx';
import { ComposeQuestion, SendLaterMenu, SendLaterSheet, SendLaterIcon, trapTab } from './SendLater.jsx';
import { shortcutBus } from '../utils/shortcutBus.js';
import { scheduledFeed } from '../utils/scheduledFeed.js';
import { browserTimeZone, formatSendAt } from '../utils/scheduleTimes.js';
import {
  SCHEDULE_UNDO_MS, SEND_NOW_DELAY_MS, UNDO_FOR, needsConfirmation, once, sendNowUndoMs, supersedeUndo, undoSendNow,
} from '../utils/scheduledCompose.js';
import { openSentMessage } from '../utils/openSentMessage.js';
import {
  actionErrorText, actionLabelKey, chipKey, chipTone, composeDataFromScheduled, formatScheduledTime, groupScheduled,
  hoverActions, isRetrying, nextRestoreEnd, primaryAction, reasonKey, recipientsOf, rowActions, rowLabel, sentNotes,
  storedZoneTime,
} from '../utils/scheduledView.js';

// The Scheduled view (#543, design 5.2): every scheduled message of every account, in three
// sections (Needs attention, Scheduled, recently Sent), with what each is doing and the actions
// its state allows. Its rows are not messages: they come from GET /api/mail/scheduled, kept
// current by utils/scheduledFeed.js. A click (a tap on a phone) edits; hover actions, the context
// menu and the keyboard (Enter edits, Delete deletes with Undo, r reschedules, s sends now) do the
// rest; on a phone the row's More button or a long press opens an action sheet.

const LONG_PRESS_MS = 500;
// How long a message a notification link points at stays highlighted.
const HIGHLIGHT_MS = 4000;

const icon = (paths, size = 14) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">{paths}</svg>
);
const ICONS = {
  edit: icon(<><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></>),
  reschedule: <SendLaterIcon size={14} />,
  sendNow: icon(<><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></>),
  sendAnyway: icon(<><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></>),
  resume: icon(<polygon points="6 4 20 12 6 20 6 4"/>),
  restore: icon(<><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></>),
  cancel: icon(<><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></>),
  more: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
    </svg>
  ),
  clip: icon(<path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>, 12),
};

const TONE_COLOR = { alert: 'var(--red)', done: 'var(--green, var(--text-secondary))', info: 'var(--accent)' };

export default function ScheduledList() {
  const { t } = useTranslation();
  const isMobile = useMobile();
  const list = useStore(s => s.scheduledList);
  const accounts = useStore(s => s.accounts);
  const highlight = useStore(s => s.scheduledHighlight);
  const notifications = useStore(s => s.notifications);
  const removeNotification = useStore(s => s.removeNotification);
  const setMobileSidebarOpen = useStore(s => s.setMobileSidebarOpen);
  const layout = useStore(s => s.layout);
  const currentLayout = LAYOUTS[layout] || LAYOUTS.comfortable;
  const isColumn = currentLayout.direction === 'column';

  // The labels say "Today" and "Tomorrow": they follow the clock.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => { scheduledFeed.refresh(); }, []);
  // A deleted message leaves the list the moment its restore window closes.
  useEffect(() => {
    const end = nextRestoreEnd(list?.messages || [], now);
    if (end == null) return undefined;
    const timer = setTimeout(() => setNow(new Date()), Math.max(0, end - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [list, now]);

  const groups = useMemo(() => groupScheduled(list?.messages || [], now), [list, now]);
  const ordered = useMemo(() => [...groups.attention, ...groups.upcoming, ...groups.sent, ...groups.deleted], [groups]);
  const total = ordered.length;

  const [busyId, setBusyId] = useState(null);
  // The same, at once: a second click or key before the busy state renders does nothing either.
  const busyRef = useRef(null);
  // Until when this tab's own Send now of a message is in its window, so a Send now repeated before
  // the list says so (sendingNow) does nothing, and the first one's Undo stays.
  const sentNowRef = useRef(new Map());
  // The menu open for a row: { row, x, y } on desktop (the context menu or More), { row } on a phone.
  const [menu, setMenu] = useState(null);
  // The row whose Reschedule times are open.
  const [picking, setPicking] = useState(null);
  // A question an action asks first: { title, body, go, kind, onGo }.
  const [ask, setAsk] = useState(null);
  const [focusedId, setFocusedId] = useState(null);
  const [hoveredId, setHoveredId] = useState(null);
  const rowRefs = useRef(new Map());
  const pickerTriggerRef = useRef(null);
  const listRef = useRef(null);

  const notify = useCallback(n => useStore.getState().addNotification(n), []);
  const subjectOf = useCallback(row => row?.summary?.subject || t('common.noSubject'), [t]);
  const fail = useCallback((row, err) => notify({
    type: 'error', title: subjectOf(row), body: actionErrorText(err, t), allowWrap: true,
  }), [notify, subjectOf, t]);

  // The roving tab stop: the focused row, else the first one.
  const tabStopId = ordered.some(r => r.id === focusedId) ? focusedId : ordered[0]?.id ?? null;
  const focusRow = (id) => {
    const el = rowRefs.current.get(id);
    if (el) { el.focus(); setFocusedId(id); }
  };
  const moveFocus = (fromId, delta) => {
    const at = ordered.findIndex(r => r.id === fromId);
    const next = ordered[Math.max(0, Math.min(ordered.length - 1, (at < 0 ? 0 : at) + delta))];
    if (next) focusRow(next.id);
  };

  // A notification link (/?scheduled=<id>) or a toast's Open: show that message, then let the
  // highlight go. One not in the list is fetched for once more (the list may predate it); still
  // missing, the user is told.
  const lookedForRef = useRef(null);
  useEffect(() => {
    if (!highlight || !list?.loadedAt) return undefined;
    const el = rowRefs.current.get(highlight);
    if (!el) {
      if (lookedForRef.current !== highlight) {
        lookedForRef.current = highlight;
        // A refetch that failed changes no list, so it is said here: not found.
        scheduledFeed.refresh().then((loaded) => {
          if (loaded || lookedForRef.current !== highlight) return;
          lookedForRef.current = null;
          if (useStore.getState().scheduledHighlight !== highlight) return;
          useStore.getState().setScheduledHighlight(null);
          notify({ title: t('scheduled.errors.linkNotFound') });
        });
        return undefined;
      }
      lookedForRef.current = null;
      useStore.getState().setScheduledHighlight(null);
      notify({ title: t('scheduled.errors.linkNotFound') });
      return undefined;
    }
    lookedForRef.current = null;
    el.scrollIntoView?.({ block: 'center' });
    el.focus({ preventScroll: true });
    setFocusedId(highlight);
    const timer = setTimeout(() => useStore.getState().setScheduledHighlight(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlight, list, notify, t]);

  // Ctrl/Cmd+Z undoes the newest undo the toasts offer, as in the message list (#449); j and k
  // move between rows.
  useEffect(() => {
    const onUndo = () => {
      const state = useStore.getState();
      const last = state.notifications.find(n => typeof n.onUndo === 'function');
      if (!last) return;
      state.removeNotification(last.id);
      void last.onUndo();
    };
    const step = delta => () => {
      const active = [...rowRefs.current.entries()].find(([, el]) => el === document.activeElement)?.[0];
      moveFocusRef.current(active ?? null, active ? delta : 0);
    };
    const onNext = step(1);
    const onPrev = step(-1);
    shortcutBus.on('undoAction', onUndo);
    shortcutBus.on('nextMessage', onNext);
    shortcutBus.on('prevMessage', onPrev);
    return () => {
      shortcutBus.off('undoAction', onUndo);
      shortcutBus.off('nextMessage', onNext);
      shortcutBus.off('prevMessage', onPrev);
    };
  }, []);
  const moveFocusRef = useRef(moveFocus);
  moveFocusRef.current = moveFocus;

  // A menu, sheet or the times of a row that left the list (sent, deleted elsewhere, its restore
  // window closed) close with it.
  useEffect(() => {
    const present = new Set(ordered.map(r => r.id));
    if (menu && !present.has(menu.row.id)) setMenu(null);
    if (picking && !present.has(picking.id)) setPicking(null);
  }, [ordered, menu, picking]);

  // Reschedule's times open under their row: brought into view when that is near the bottom.
  useEffect(() => {
    if (!picking || isMobile) return;
    listRef.current?.querySelector(`[data-scheduled-row="${picking.id}"] [role="menu"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [picking, isMobile]);

  // One action against the server. A question the server asks (confirm_uncertain,
  // confirm_restored) is put to the user, and their yes repeats the request with confirm.
  const attempt = async (row, call, onDone, { go } = {}, confirm = false) => {
    busyRef.current = row.id;
    setBusyId(row.id);
    try {
      const result = await call(confirm);
      // Done: an Undo still offered for this message (its schedule, a Send now, a Delete) would
      // put back what this changed, so it goes. A refused action leaves it.
      supersedeUndo(useStore, row.id);
      await onDone?.(result);
    } catch (err) {
      if (!confirm && needsConfirmation(err)) {
        const uncertain = err.code === 'confirm_uncertain';
        setAsk({
          title: uncertain ? t('scheduled.confirm.uncertainTitle') : t('scheduled.confirm.restoredTitle'),
          body: uncertain ? t('scheduled.confirm.uncertainBody') : t('scheduled.confirm.restoredBody'),
          go: go || (uncertain ? t('scheduled.actions.sendAnyway') : t('scheduled.confirm.restoredGo')),
          kind: 'danger',
          onGo: () => attempt(row, call, onDone, { go }, true),
        });
      } else {
        fail(row, err);
      }
    } finally {
      busyRef.current = null;
      setBusyId(null);
      scheduledFeed.refresh();
    }
  };

  const restore = (row) => api.scheduled.restore(row.id)
    .then((r) => {
      supersedeUndo(useStore, row.id);
      const body = subjectOf(row);
      // Its time passed meanwhile: the server put it back paused, so it never goes out at once.
      if (r?.status === 'paused' && r.pauseReason === 'user') notify({ title: t('scheduled.toast.restoredPaused'), body });
      else if (r?.status === 'scheduled') notify({ title: t('compose.scheduleSend.scheduledFor', { when: formatSendAt(r.sendAt) }), body });
      else notify({ title: t('scheduled.toast.restored'), body });
    })
    .catch((err) => {
      notify({
        type: 'error', title: t('scheduled.errors.restoreFailed'), allowWrap: true,
        // Past its window it is 409 until the purge, then 404: either way it is too late.
        body: (err?.status === 409 && err.state === 'cancelled') || err?.status === 404
          ? t('scheduled.errors.restoreExpired') : actionErrorText(err, t),
      });
    })
    .finally(() => scheduledFeed.refresh());

  const run = (action, row) => {
    if (!row || busyId || busyRef.current) return;
    if (action === 'sendNow' && (row.sendingNow || (sentNowRef.current.get(row.id) || 0) > Date.now())) return;
    setMenu(null);
    // Focus goes to the row first, so a question or the times hand it back there when they close
    // (a hover button may be gone by then), and its actions stay shown while it is focused.
    if (!isMobile) focusRow(row.id);
    const subject = subjectOf(row);
    const owner = useStore.getState().user?.id;
    const mine = () => useStore.getState().user?.id === owner;
    switch (action) {
      case 'edit':
        busyRef.current = row.id;
        setBusyId(row.id);
        api.scheduled.get(row.id)
          .then((detail) => {
            if (!detail?.spec || ['sending', 'sent'].includes(detail.status)) {
              fail(row, Object.assign(new Error(''), { status: 409, state: detail?.status }));
              return;
            }
            // An open composer is asked first, as for any message; it says why when it keeps its own.
            // Once it is open on the message, an Undo still offered for it goes.
            return Promise.resolve(useStore.getState().openCompose(composeDataFromScheduled(detail)))
              .then(opened => { if (opened) supersedeUndo(useStore, row.id); });
          })
          .catch(err => fail(row, err))
          .finally(() => { busyRef.current = null; setBusyId(null); });
        return;
      case 'reschedule':
        pickerTriggerRef.current = rowRefs.current.get(row.id) || null;
        setPicking(row);
        return;
      case 'sendNow': {
        let started = 0;
        attempt(row, (confirm) => { started = Date.now(); return api.scheduled.sendNow(row.id, confirm); }, (r) => {
          sentNowRef.current.set(row.id, started + SEND_NOW_DELAY_MS);
          notify({
            title: t('compose.undoSend.sending', { subject }),
            undoMs: sendNowUndoMs(started),
            [UNDO_FOR]: row.id,
            onUndo: once(() => {
              if (!mine()) return;
              return undoSendNow({ id: row.id, undoToken: r.undoToken, subject }, {
                undo: api.scheduled.undoSendNow, notify, t,
              }).then((undone) => { if (undone) sentNowRef.current.delete(row.id); })
                .finally(() => scheduledFeed.refresh());
            }),
          });
        });
        return;
      }
      case 'resume':
        attempt(row, confirm => api.scheduled.resume(row.id, confirm), () => notify({ title: t('scheduled.toast.resumed'), body: subject }));
        return;
      case 'sendAnyway':
        setAsk({
          title: t('scheduled.confirm.sendAnywayTitle'), body: t('scheduled.confirm.sendAnywayBody'),
          go: t('scheduled.actions.sendAnyway'), kind: 'danger',
          onGo: () => attempt(row, () => api.scheduled.sendAnyway(row.id), () => notify({ title: t('scheduled.toast.sendingNow'), body: subject })),
        });
        return;
      case 'markSent':
        setAsk({
          title: t('scheduled.confirm.markSentTitle'), body: t('scheduled.confirm.markSentBody'),
          go: t('scheduled.actions.markSent'), kind: 'primary',
          onGo: () => attempt(row, () => api.scheduled.markSent(row.id), () => notify({ title: t('scheduled.toast.markedSent'), body: subject })),
        });
        return;
      case 'cancel':
        attempt(row, () => api.scheduled.cancel(row.id), () => notify({
          title: t('scheduled.toast.deleted'), body: subject, undoMs: SCHEDULE_UNDO_MS, [UNDO_FOR]: row.id,
          onUndo: once(() => (mine() ? restore(row) : undefined)),
        }));
        return;
      case 'delete':
        setAsk({
          title: t('scheduled.confirm.deleteTitle'), body: t('scheduled.confirm.deleteBody'),
          go: t('scheduled.actions.delete'), kind: 'danger',
          onGo: () => attempt(row, () => api.scheduled.remove(row.id), () => notify({ title: t('scheduled.toast.deletedForGood'), body: subject })),
        });
        return;
      case 'remove':
        attempt(row, () => api.scheduled.remove(row.id));
        return;
      case 'restore':
        busyRef.current = row.id;
        setBusyId(row.id);
        restore(row).finally(() => { busyRef.current = null; setBusyId(null); });
        return;
      case 'viewSent':
        openSentMessage(useStore, { accountId: row.accountId, folder: row.result.sentFolder, messageId: row.result.messageId });
        return;
      default:
    }
  };

  const pickTime = (row, at) => {
    setPicking(null);
    attempt(row, confirm => api.scheduled.reschedule(row.id, { sendAt: at.toISOString(), timeZone: browserTimeZone() }, confirm),
      r => notify({ title: t('compose.scheduleSend.scheduledFor', { when: formatSendAt(r?.sendAt || at) }), body: subjectOf(row) }),
      { go: t('compose.scheduleSend.confirm.go') });
  };

  // Keys on a focused row (design 5.2). They stop here, so the mailbox shortcuts (r is Reply, s
  // is Star) do not run as well.
  const onRowKeyDown = (e, row) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // A held key repeats: one Send now or Delete, not one per repeat.
    const firstPress = fn => () => { if (!e.repeat) fn(); };
    const allowed = rowActions(row);
    const take = (fn) => { e.preventDefault(); e.stopPropagation(); fn(); };
    if (e.key === 'ArrowDown' || e.key === 'j') take(() => moveFocus(row.id, 1));
    else if (e.key === 'ArrowUp' || e.key === 'k') take(() => moveFocus(row.id, -1));
    else if (e.key === 'Home') take(() => focusRow(ordered[0]?.id));
    else if (e.key === 'End') take(() => focusRow(ordered[ordered.length - 1]?.id));
    else if (e.key === 'Delete' && allowed.includes('cancel')) take(firstPress(() => run('cancel', row)));
    else if (e.key === 'r' && !e.shiftKey && allowed.includes('reschedule')) take(() => run('reschedule', row));
    else if (e.key === 's' && !e.shiftKey && allowed.includes('sendNow')) take(firstPress(() => run('sendNow', row)));
    else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      take(() => {
        const box = e.currentTarget.getBoundingClientRect();
        setMenu({ row, x: box.left + 24, y: box.bottom - 4, returnTo: e.currentTarget });
      });
    }
  };

  const accountOf = id => accounts.find(a => a.id === id);
  const renderRow = (row) => (
    <ScheduledRow
      key={row.id}
      row={row}
      t={t}
      now={now}
      account={accountOf(row.accountId)}
      isMobile={isMobile}
      busy={busyId === row.id}
      highlighted={highlight === row.id}
      tabStop={tabStopId === row.id}
      showHover={!isMobile && (hoveredId === row.id || focusedId === row.id)}
      refFor={(el) => { if (el) rowRefs.current.set(row.id, el); else rowRefs.current.delete(row.id); }}
      onPrimary={() => { const a = primaryAction(row); if (a) run(a, row); }}
      onAction={a => run(a, row)}
      onKeyDown={e => onRowKeyDown(e, row)}
      onFocus={() => setFocusedId(row.id)}
      onHover={on => setHoveredId(on ? row.id : (cur => (cur === row.id ? null : cur)))}
      onMenu={(pos) => setMenu({ row, ...pos })}
      picker={!isMobile && picking?.id === row.id ? (
        <SendLaterMenu
          triggerRef={pickerTriggerRef}
          placement="below"
          title={t('scheduled.actions.reschedule')}
          submitLabel={t('scheduled.actions.reschedule')}
          onClose={() => setPicking(null)}
          onPick={at => pickTime(row, at)}
        />
      ) : null}
    />
  );

  const section = (key, title, rows, footer, { count = true } = {}) => rows.length > 0 && (
    <Section key={key} id={key} title={title} count={count ? rows.length : null} isMobile={isMobile} footer={footer}>
      {rows.map(renderRow)}
    </Section>
  );

  const undoable = notifications.filter(n => n.onUndo);
  const title = t('sidebar.scheduled');

  return (
    <div data-scheduled-view="" style={{
      width: isMobile ? '100%' : (isColumn ? '100%' : 'var(--list-width)'),
      minWidth: isMobile ? undefined : (isColumn ? undefined : 180),
      flex: isMobile ? 1 : (isColumn ? '0 0 42%' : undefined),
      minHeight: isColumn && !isMobile ? 0 : undefined,
      borderRight: (isMobile || isColumn) ? 'none' : '1px solid var(--border-subtle)',
      borderBottom: (!isMobile && isColumn) ? '1px solid var(--border-subtle)' : 'none',
      display: 'flex', flexDirection: 'column',
      height: (isMobile || isColumn) ? undefined : '100%',
      background: 'var(--bg-primary)',
    }}>
      {isMobile ? (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 4,
          paddingTop: 'calc(var(--sat) + 10px)', paddingBottom: 'calc(10px - var(--sat-trim))', paddingLeft: 12, paddingRight: 12,
          borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)', flexShrink: 0,
        }}>
          <button
            type="button"
            onClick={() => setMobileSidebarOpen(true)}
            aria-label={t('messageList.menu', 'Menu')}
            style={{
              background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 0, borderRadius: 7,
              display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 44, minHeight: 44,
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
              <line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>
            </svg>
          </button>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', flex: 1, minWidth: 0 }}>{title}</h2>
          <RefreshButton t={t} mobile />
        </div>
      ) : (
        <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', flex: 1, minWidth: 0 }}>{title}</h2>
          {list?.loadedAt && <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{total}</span>}
          <RefreshButton t={t} />
        </div>
      )}

      <div ref={listRef} style={{ flex: 1, overflowY: 'auto', minHeight: 0, paddingBottom: isMobile ? 'calc(var(--sab) + 24px)' : 8 }}>
        {!list ? (
          <div role="status" style={{ padding: 40, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>{t('common.loading')}</div>
        ) : list.error && !total ? (
          <div role="alert" style={{ padding: '48px 24px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>
            <div style={{ marginBottom: 12 }}>{t('scheduled.loadFailed')}</div>
            <button type="button" onClick={() => { useStore.getState().setScheduledList(null); scheduledFeed.refresh(); }}
              style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', padding: '8px 16px', minHeight: isMobile ? 44 : undefined, cursor: 'pointer' }}>
              {t('common.retry')}
            </button>
          </div>
        ) : !total ? (
          <div style={{ padding: '60px 40px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
            <span style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}><SendLaterIcon size={28} /></span>
            <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 6 }}>{t('scheduled.empty')}</div>
            <div style={{ fontSize: 13 }}>{t('scheduled.emptyDesc')}</div>
          </div>
        ) : (
          <>
            {section('attention', t('scheduled.sections.attention'), groups.attention)}
            {section('upcoming', t('scheduled.sections.scheduled'), groups.upcoming)}
            {section('sent', t('scheduled.sections.sent'), groups.sent, list.moreSent ? t('scheduled.moreSent') : null)}
            {section('deleted', t('scheduled.sections.deleted'), groups.deleted, null, { count: false })}
          </>
        )}
      </div>

      {!isMobile && undoable.map((n, i) => (
        <UndoBar key={n.id} notification={n} onDismiss={() => removeNotification(n.id)} showTopBorder={i === 0} />
      ))}

      {menu && !isMobile && (
        <ActionMenu row={menu.row} x={menu.x} y={menu.y} returnTo={menu.returnTo} t={t}
          onClose={() => setMenu(null)} onAction={a => run(a, menu.row)} />
      )}
      {menu && isMobile && (
        <ActionSheet row={menu.row} t={t} subject={subjectOf(menu.row)} returnTo={menu.returnTo}
          onClose={() => setMenu(null)} onAction={a => run(a, menu.row)} />
      )}
      {picking && isMobile && (
        <SendLaterSheet
          title={t('scheduled.actions.reschedule')}
          submitLabel={t('scheduled.actions.reschedule')}
          returnFocusRef={pickerTriggerRef}
          onClose={() => setPicking(null)}
          onPick={at => pickTime(picking, at)}
        />
      )}
      {ask && (
        <ComposeQuestion
          mobile={isMobile}
          title={ask.title}
          body={ask.body}
          onCancel={() => setAsk(null)}
          actions={[
            { label: ask.go, kind: ask.kind, onClick: () => { const go = ask.onGo; setAsk(null); go(); } },
            // Every question here would send again, send what a restore paused, or delete: the
            // safe answer has the focus.
            { label: t('common.cancel'), kind: 'plain', focus: true, onClick: () => setAsk(null) },
          ]}
        />
      )}
    </div>
  );
}

function RefreshButton({ t, mobile = false }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      onClick={() => { setBusy(true); scheduledFeed.refresh().finally(() => setBusy(false)); }}
      disabled={busy}
      title={t('scheduled.refresh')}
      aria-label={t('scheduled.refresh')}
      style={{
        background: 'none', border: '1px solid transparent', borderRadius: 6, padding: mobile ? 0 : '4px 6px',
        minWidth: mobile ? 44 : undefined, minHeight: mobile ? 44 : undefined, justifyContent: 'center',
        color: busy ? 'var(--accent)' : 'var(--text-tertiary)', cursor: busy ? 'default' : 'pointer', display: 'flex', alignItems: 'center',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
      </svg>
    </button>
  );
}

function Section({ id, title, count, isMobile, footer, children }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} data-scheduled-section={id}>
      <h3 id={headingId} style={{
        margin: 0, padding: isMobile ? '14px 16px 6px' : '12px 16px 4px', fontSize: 11, fontWeight: 600,
        textTransform: 'uppercase', letterSpacing: '0.06em', color: id === 'attention' ? 'var(--red)' : 'var(--text-tertiary)',
        display: 'flex', gap: 6,
      }}>
        <span>{title}</span>{count != null && <span style={{ fontWeight: 500 }}>{count}</span>}
      </h3>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{children}</ul>
      {footer && <div style={{ padding: '8px 16px 12px', fontSize: 12, color: 'var(--text-tertiary)' }}>{footer}</div>}
    </section>
  );
}

function ScheduledRow({
  row, t, now, account, isMobile, busy, highlighted, tabStop, showHover, refFor, onPrimary, onAction, onKeyDown, onFocus,
  onHover, onMenu, picker,
}) {
  const summary = row.summary;
  const { names, more } = recipientsOf(summary);
  const when = formatScheduledTime(row.status === 'sent' ? (row.sentAt || row.sendAt) : row.sendAt, { t, now });
  const zone = row.status === 'sent' ? null : storedZoneTime(row.sendAt, row.timeZone);
  const chip = chipKey(row);
  const reasonId = reasonKey(row);
  const reason = !reasonId ? null
    : isRetrying(row) ? t(reasonId, { when: formatScheduledTime(row.dueAt, { t, now }) })
      : row.status === 'cancelled' ? t(reasonId, { when: formatScheduledTime(row.restoreUntil, { t, now }) })
        : t(reasonId);
  const notes = sentNotes(row, { t, now });
  // The server's reply, or MailFlow's explanation; never "try again" beside an uncertain message.
  const detail = row.failureDetail && (reasonId || isRetrying(row))
    && !(row.status === 'uncertain' && /try again/i.test(row.failureDetail)) ? row.failureDetail : null;
  const serverReply = detail && /^[245]\d\d[\s-]/.test(detail);
  const subject = summary?.subject || (row.status === 'sent' && !summary ? t('scheduled.sentMessage') : t('common.noSubject'));
  const to = names.length
    ? (more ? t('scheduled.toMore', { names: names.join(', '), more }) : t('scheduled.to', { names: names.join(', ') }))
    : null;
  const label = rowLabel(row, { t, when, summary, reason });
  const accountLabel = account ? (account.name || account.email_address) : null;
  const hover = hoverActions(row);
  const all = rowActions(row);
  const pressRef = useRef({ timer: null, fired: false });

  const startPress = (e) => {
    if (!isMobile || !all.length) return;
    const target = e.currentTarget;
    clearTimeout(pressRef.current.timer);
    pressRef.current.fired = false;
    pressRef.current.timer = setTimeout(() => {
      pressRef.current.fired = true;
      onMenu({ returnTo: target });
    }, LONG_PRESS_MS);
  };
  const endPress = () => clearTimeout(pressRef.current.timer);
  useEffect(() => () => clearTimeout(pressRef.current.timer), []);

  return (
    <li
      data-scheduled-row={row.id}
      data-status={row.status}
      style={{ position: 'relative', borderBottom: '1px solid var(--border-subtle)' }}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onContextMenu={(e) => {
        if (!all.length) return;
        e.preventDefault();
        if (isMobile) { if (!pressRef.current.fired) onMenu({ returnTo: e.currentTarget.querySelector('button') }); return; }
        onMenu({ x: e.clientX, y: e.clientY, returnTo: e.currentTarget.querySelector('button') });
      }}
    >
      <button
        type="button"
        ref={refFor}
        aria-label={label}
        aria-busy={busy || undefined}
        tabIndex={tabStop ? 0 : -1}
        onClick={() => {
          if (pressRef.current.fired) { pressRef.current.fired = false; return; }
          onPrimary();
        }}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onTouchStart={startPress}
        onTouchEnd={endPress}
        onTouchMove={endPress}
        onTouchCancel={endPress}
        style={{
          display: 'block', width: '100%', textAlign: 'left', border: 'none', cursor: primaryAction(row) ? 'pointer' : 'default',
          padding: isMobile ? '12px 56px 12px 16px' : '10px 16px', minHeight: isMobile ? 64 : undefined,
          background: highlighted ? 'var(--accent-dim)' : 'transparent', color: 'var(--text-primary)', font: 'inherit',
          opacity: busy ? 0.6 : 1, transition: 'background 0.3s', WebkitTapHighlightColor: 'transparent',
          WebkitTouchCallout: 'none',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <AccountMark accountId={row.accountId} color={account?.color || 'var(--text-tertiary)'} size={7} />
          <span style={{ flex: 1, minWidth: 0, fontSize: isMobile ? 15 : 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {to || subject}
          </span>
          {summary?.attachmentCount > 0 && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 2, color: 'var(--text-tertiary)', fontSize: 11, flexShrink: 0 }}>
              {ICONS.clip}{summary.attachmentCount}
            </span>
          )}
          <span style={{ fontSize: 12, color: chip && chipTone(row) === 'alert' ? 'var(--red)' : 'var(--text-secondary)', flexShrink: 0, whiteSpace: 'nowrap' }}>{when}</span>
        </span>
        {to && (
          <span style={{ display: 'block', fontSize: isMobile ? 14 : 13, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)' }}>
            {subject}
            {summary?.snippet && <span style={{ color: 'var(--text-tertiary)' }}>{` - ${summary.snippet}`}</span>}
          </span>
        )}
        {(chip || reason) && (
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 4, fontSize: 12, minWidth: 0 }}>
            {chip && (
              <span data-scheduled-chip="" style={{
                flexShrink: 0, padding: '1px 6px', borderRadius: 4, fontSize: 11, fontWeight: 600,
                color: TONE_COLOR[chipTone(row)], border: `1px solid ${TONE_COLOR[chipTone(row)]}`,
              }}>
                {t(chip)}
              </span>
            )}
            {reason && <span style={{ color: 'var(--text-secondary)', minWidth: 0 }}>{reason}</span>}
          </span>
        )}
        {detail && (
          <span style={{ display: 'block', marginTop: 2, fontSize: 11, color: 'var(--text-tertiary)', overflowWrap: 'anywhere' }}>
            {serverReply ? t('scheduled.serverReply', { detail }) : t('scheduled.detail', { detail })}
          </span>
        )}
        {notes.map(n => (
          <span key={n.key} data-scheduled-note={n.key} style={{ display: 'block', marginTop: 2, fontSize: 12, color: n.tone === 'alert' ? 'var(--red)' : 'var(--text-secondary)', overflowWrap: 'anywhere' }}>
            {n.text}
          </span>
        ))}
        {(accountLabel || zone) && (
          <span style={{ display: 'block', marginTop: 3, fontSize: 11, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {[accountLabel, zone ? t('scheduled.zoneTime', zone) : null].filter(Boolean).join(' · ')}
          </span>
        )}
      </button>

      {showHover && hover.length > 0 && (
        <span style={{
          position: 'absolute', top: 6, right: 10, display: 'flex', gap: 2, padding: 2, borderRadius: 7,
          background: 'var(--bg-elevated)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-soft)',
        }}>
          {hover.map(a => (
            <button key={a} type="button" tabIndex={-1} disabled={busy} data-scheduled-action={a}
              title={t(actionLabelKey(a, row))} aria-label={t(actionLabelKey(a, row))}
              onClick={(e) => { e.stopPropagation(); onAction(a); }}
              style={{
                background: 'none', border: 'none', borderRadius: 5, padding: 5, cursor: 'pointer', display: 'flex',
                color: a === 'cancel' ? 'var(--red)' : 'var(--text-secondary)',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
            >
              {ICONS[a]}
            </button>
          ))}
          <button type="button" tabIndex={-1} title={t('scheduled.actions.more')} aria-label={t('scheduled.actions.more')} aria-haspopup="menu"
            onClick={(e) => { e.stopPropagation(); const box = e.currentTarget.getBoundingClientRect(); onMenu({ x: box.left, y: box.bottom + 4, returnTo: e.currentTarget.closest('li')?.querySelector('button') }); }}
            style={{ background: 'none', border: 'none', borderRadius: 5, padding: 3, cursor: 'pointer', display: 'flex', color: 'var(--text-secondary)' }}>
            {ICONS.more}
          </button>
        </span>
      )}

      {isMobile && all.length > 0 && (
        <button type="button" data-scheduled-more="" aria-label={t('scheduled.actions.more')} aria-haspopup="dialog" disabled={busy}
          onClick={(e) => { e.stopPropagation(); onMenu({ returnTo: e.currentTarget }); }}
          style={{
            position: 'absolute', top: 8, right: 6, width: 44, height: 44, background: 'none', border: 'none', borderRadius: 8,
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', cursor: 'pointer',
          }}>
          {ICONS.more}
        </button>
      )}
      {picker}
    </li>
  );
}

// The context menu of a row on desktop, at the pointer (or under the row from the keyboard): an
// ARIA menu with arrow keys, Home, End and Escape, that gives focus back to where it came from.
function ActionMenu({ row, x, y, returnTo, t, onClose, onAction }) {
  const boxRef = useRef(null);
  const [pos, setPos] = useState({ x, y });
  const actions = rowActions(row);
  useLayoutEffect(() => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPos({ x: Math.max(8, Math.min(x, vw - box.width - 8)), y: Math.max(8, Math.min(y, vh - box.height - 8)) });
  }, [x, y]);
  useEffect(() => {
    boxRef.current?.querySelector('[role="menuitem"]')?.focus();
    const onDown = (e) => { if (!boxRef.current?.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);
  const close = () => { onClose(); returnTo?.focus?.(); };
  const onKeyDown = (e) => {
    const items = [...boxRef.current.querySelectorAll('[role="menuitem"]')];
    const at = items.indexOf(document.activeElement);
    const move = (i) => { e.preventDefault(); items[(i + items.length) % items.length]?.focus(); };
    if (e.key === 'ArrowDown') move(at + 1);
    else if (e.key === 'ArrowUp') move(at < 0 ? items.length - 1 : at - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(items.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') onClose();
    else e.stopPropagation();
  };
  return (
    <div ref={boxRef} role="menu" aria-label={t('scheduled.actions.menu')} onKeyDown={onKeyDown}
      style={{
        position: 'fixed', left: pos.x, top: pos.y, zIndex: 2000, minWidth: 200, padding: '4px 0',
        background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
      }}>
      {actions.map(a => (
        <button key={a} type="button" role="menuitem" tabIndex={-1} data-scheduled-action={a}
          onClick={() => { returnTo?.focus?.(); onAction(a); }}
          style={{
            display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '7px 14px', background: 'transparent', border: 'none',
            textAlign: 'left', cursor: 'pointer', fontSize: 13, outline: 'none',
            color: a === 'delete' || a === 'cancel' ? 'var(--red)' : 'var(--text-primary)',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          onFocus={e => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
          onBlur={e => { e.currentTarget.style.background = 'transparent'; }}
        >
          <span style={{ display: 'flex', width: 14, color: 'var(--text-tertiary)' }}>{ICONS[a] || null}</span>
          {t(actionLabelKey(a, row))}
        </button>
      ))}
    </div>
  );
}

// The phone's action sheet for a row: the same actions, as a modal bottom sheet with 52 px rows.
function ActionSheet({ row, t, subject, returnTo, onClose, onAction }) {
  const titleId = useId();
  const sheetRef = useRef(null);
  const actions = rowActions(row);
  useEffect(() => {
    sheetRef.current?.querySelector('button')?.focus();
    return () => { if (returnTo?.isConnected) returnTo.focus?.(); };
  }, [returnTo]);
  const sheetButton = {
    width: '100%', minHeight: 52, padding: '12px 20px', textAlign: 'left', background: 'none', border: 'none',
    borderBottom: '1px solid var(--border-subtle)', fontSize: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12,
    WebkitTapHighlightColor: 'transparent',
  };
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 2100, background: 'rgba(0,0,0,0.4)' }} />
      <div ref={sheetRef} role="dialog" aria-modal="true" aria-labelledby={titleId} data-scheduled-sheet=""
        onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } else trapTab(e, sheetRef.current); }}
        style={{
          position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 2101, background: 'var(--bg-elevated)',
          borderRadius: '16px 16px 0 0', paddingBottom: 'calc(var(--sab) + 8px)', boxShadow: 'var(--shadow-modal)',
          animation: 'sheet-enter 0.22s var(--ease-emphasized) both', maxHeight: '85vh', overflowY: 'auto',
        }}>
        <div id={titleId} style={{
          padding: '16px 20px 10px', fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-subtle)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {subject}
        </div>
        {actions.map(a => (
          <button key={a} type="button" data-scheduled-action={a} onClick={() => onAction(a)}
            style={{ ...sheetButton, color: a === 'delete' || a === 'cancel' ? 'var(--red)' : 'var(--text-primary)' }}>
            <span style={{ display: 'flex', width: 16, color: 'var(--text-tertiary)' }}>{ICONS[a] || null}</span>
            <span style={{ flex: 1 }}>{t(actionLabelKey(a, row))}</span>
          </button>
        ))}
        <button type="button" onClick={onClose} style={{ ...sheetButton, borderBottom: 'none', color: 'var(--text-secondary)' }}>
          {t('common.cancel')}
        </button>
      </div>
    </>
  );
}

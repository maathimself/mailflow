import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useStore, selectSelectedMessageMid } from '../store/index.js';
import { api } from '../utils/api.js';
import {
  GTD_COLORS, GTD_CHIP_BG,
  buildGtdDisplaySections, resolveRowDisplay,
  openDeepLinkMessage, isSelectedRow, collectThreadReadIds, openGtdThreadWithAutoRead,
  classifyThread, unclassifyThread,
} from '../utils/gtd.js';
import GtdEntryRow from './GtdEntryRow.jsx';
import GtdZeroPet from './GtdZeroPet.jsx';
import RowHoverActions from './RowHoverActions.jsx';
import ContextMenu from './ContextMenu.jsx';
import RightSidebar from './RightSidebar.jsx';

// Section key -> the state color/chip-bg used for its header, count chip, and the
// row's left border. Waiting rows override per gtdKind (watch/delegated).
const SECTION_STATE = { todo: 'todo', waiting: 'watch', reference: 'reference', someday: 'someday' };

export default function GtdSidebarContent({ onCollapse, toggleHint }) {
  const { t } = useTranslation();
  const gtdSections = useStore(s => s.gtdSections);
  const gtdCollapsedSections = useStore(s => s.gtdCollapsedSections);
  const toggleGtdSection = useStore(s => s.toggleGtdSection);
  const setActiveGtdTab = useStore(s => s.setActiveGtdTab);
  const setThreadMessages = useStore(s => s.setThreadMessages);
  const setSelectedMessage = useStore(s => s.setSelectedMessage);
  const scheduleGtdSectionsFetch = useStore(s => s.scheduleGtdSectionsFetch);
  const removeGtdThread = useStore(s => s.removeGtdThread);
  const markGtdThreadRead = useStore(s => s.markGtdThreadRead);
  const markGtdThreadStarred = useStore(s => s.markGtdThreadStarred);
  const addNotification = useStore(s => s.addNotification);
  const selectedMessageId = useStore(s => s.selectedMessageId);
  const selectedMid = useStore(selectSelectedMessageMid);

  // Right-click / move-picker menu for a sidebar row. Carries the row's doneStates so the
  // menu's "done" and "move" stay section-scoped (the row knows which section it's in).
  const [contextMenu, setContextMenu] = useState(null);
  const autoMarkReadTimerRef = useRef(null);
  // Identity (message_id||id) the pending auto-read was scheduled for, so a rapid-triage action
  // on a DIFFERENT row can't cancel it — only openRow (supersession) and an action on THIS row do.
  const autoMarkReadThreadRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(autoMarkReadTimerRef.current);
    };
  }, []);

  // Drop the pending delay-mode auto-read outright (handle + owner identity). openRow uses this:
  // a fresh open genuinely supersedes the prior row's pending read. Same clear+null idiom the
  // unmount cleanup uses (which clears the handle directly).
  const cancelAutoMarkRead = () => {
    clearTimeout(autoMarkReadTimerRef.current);
    autoMarkReadTimerRef.current = null;
    autoMarkReadThreadRef.current = null;
  };

  // Cancel the pending auto-read ONLY when it was scheduled for `thread`: an explicit mark-unread
  // or a done/delete/move on the just-opened row must not let a stale (is_read=false) readThread
  // later revert it or fire a spurious bulkRead — but the same action on a DIFFERENT visible row
  // (rapid triage) must leave that other row's still-legitimate pending read running.
  const cancelAutoMarkReadFor = (thread) => {
    const identity = thread.message_id || thread.id;
    if (autoMarkReadThreadRef.current != null && autoMarkReadThreadRef.current === identity) {
      cancelAutoMarkRead();
    }
  };

  // Sections are fetched by MailApp on context change (single owner); the sidebar
  // just renders the store slice and updates live via gtd_sections_updated.
  const sections = buildGtdDisplaySections(gtdSections);
  const loaded = gtdSections != null;
  const allClear = loaded && sections.every(s => s.total === 0);

  // The GTD "done" action: strip this row's label(s) (`states`), mark read, archive.
  // Optimistically drop the row so it feels instant; the WS refetch reconciles. On
  // failure, restore via a refetch and surface a notification (no undo toast).
  const doneRow = async (thread, states) => {
    cancelAutoMarkReadFor(thread);
    removeGtdThread(thread.message_id || thread.id, states);
    try {
      const res = await api.gtdDone(thread.id, states);
      // Labels stripped but the archive step failed: the optimistic removal is still
      // correct (the row left its GTD sections), yet the email remains in the inbox —
      // tell the user so the missing archive isn't a silent surprise.
      if (res?.archiveFailed) {
        addNotification({ title: t('gtd.doneArchiveFailed'), body: thread.subject || t('common.noSubject') });
      }
      scheduleGtdSectionsFetch();
    } catch (err) {
      console.error('GTD done failed:', err.message);
      addNotification({ title: t('gtd.doneFailed'), body: thread.subject || t('common.noSubject') });
      scheduleGtdSectionsFetch();
    }
  };

  // ── Shared-surface row actions (hover cluster + context menu) ──────────────────
  // Standalone equivalents of MessageList's closures, deliberately lighter: call the
  // api and let the read/star fan-out + the gtd refetch reconcile, with only the cheap
  // optimistic touches (is_read flip, section-row removal) applied here.

  // Read: flip is_read on the section thread instantly. Section rows carry thread-level
  // unread, so marking READ acts on every message in the thread (collectThreadReadIds —
  // the same-message_id fan-out alone can't reach an INBOX-only sibling reply), while
  // marking UNREAD needs only the head copy. On failure, flip back.
  const setRead = async (thread, read) => {
    // Explicit mark-unread wins over a pending auto-read: cancel the timer before the no-op
    // guard so it can't later flip this just-opened thread back to read.
    if (!read) cancelAutoMarkReadFor(thread);
    if (!!thread.is_read === read) return;
    const identity = thread.message_id || thread.id;
    markGtdThreadRead(identity, read);
    try {
      await api.bulkRead(await collectThreadReadIds(thread, read, api.getThread), read);
      // Belt-and-braces under the WS read fan-out: reconcile the sidebar counts (the
      // debounce coalesces this with any gtd_sections_updated the mark triggers).
      scheduleGtdSectionsFetch();
    } catch (err) {
      console.error('GTD read toggle failed:', err.message);
      markGtdThreadRead(identity, !read);
    }
  };

  const openRow = (thread) => {
    cancelAutoMarkRead();
    const identity = thread.message_id || thread.id;
    return openGtdThreadWithAutoRead(thread, {
      openThread: () => openDeepLinkMessage(thread.id, {
        getMessage: api.getMessage,
        getThread: api.getThread,
        setThreadMessages,
        setSelectedMessage,
        thread,
        onMiss: scheduleGtdSectionsFetch,
      }),
      isCancelled: () => !mountedRef.current,
      getPreferences: () => useStore.getState(),
      readThread: setRead,
      publishTimer: timerHandle => {
        autoMarkReadTimerRef.current = timerHandle;
        // Only a scheduled (delay-mode) timer has an owner to guard; immediate/manual publish null.
        autoMarkReadThreadRef.current = timerHandle == null ? null : identity;
      },
    });
  };

  // Star: flip is_starred on the section thread instantly (identity-wide, so a merged
  // Waiting row stays consistent across watch+delegated); the star fans out to sibling
  // copies server-side. On failure, flip back.
  const toggleStar = async (thread) => {
    const identity = thread.message_id || thread.id;
    const next = !thread.is_starred;
    markGtdThreadStarred(identity, next);
    try {
      await api.markStarred(thread.id, next);
    } catch (err) {
      console.error('GTD star toggle failed:', err.message);
      markGtdThreadStarred(identity, !next);
    }
  };

  // Delete this row's copy (the label-folder message). Optimistically drop the row from
  // its section(s); the refetch reconciles (and, on failure, restores it) — no undo timer.
  const deleteRow = (thread, states) => {
    cancelAutoMarkReadFor(thread);
    removeGtdThread(thread.message_id || thread.id, states);
    api.deleteMessage(thread.id)
      .then(scheduleGtdSectionsFetch)
      .catch(err => {
        console.error('GTD delete failed:', err.message);
        addNotification({ title: t('messageList.deleted.failTitle'), body: thread.subject || t('common.noSubject') });
        scheduleGtdSectionsFetch();
      });
  };

  // Move this row's copy to another folder — it leaves its GTD label folder, so drop it
  // from its section(s) optimistically; the refetch reconciles.
  const moveRow = (thread, states, folder) => {
    if (!folder) return;
    cancelAutoMarkReadFor(thread);
    removeGtdThread(thread.message_id || thread.id, states);
    api.bulkMove([thread.id], folder)
      .then(() => {
        useStore.getState().recordRecentFolder({ accountId: thread.account_id, path: folder });
        scheduleGtdSectionsFetch();
      })
      .catch(err => {
        console.error('GTD move failed:', err.message);
        addNotification({ title: t('message.moved.failTitle'), body: t('message.moved.failBody') });
        scheduleGtdSectionsFetch();
      });
  };

  // Classify (add a state label) / remove (strip one). The message stays put, so just
  // poke the sidebar store to reconverge — mirrors MessageList's context-menu handlers.
  const classifyRow = (thread, state) => classifyThread(thread.id, state, {
    gtdClassify: api.gtdClassify, addNotification, scheduleGtdSectionsFetch, t,
  });

  const removeStateRow = (thread, state) => unclassifyThread(thread.id, state, {
    gtdUnclassify: api.gtdUnclassify, addNotification, scheduleGtdSectionsFetch, t,
  });

  // ContextMenu's onAction, routed to the primitives above. `menu` is the open
  // contextMenu (its .message is the row, .doneStates its section-scoped states).
  const handleGtdAction = (action, menu, data) => {
    const thread = menu.message;
    switch (action) {
      case 'open': openRow(thread); break;
      case 'markRead': setRead(thread, true); break;
      case 'markUnread': setRead(thread, false); break;
      case 'toggleStar': toggleStar(thread); break;
      case 'moveTo': moveRow(thread, menu.doneStates, data); break;
      case 'gtdClassify': classifyRow(thread, data); break;
      case 'gtdRemove': removeStateRow(thread, data); break;
      case 'gtdDone': doneRow(thread, menu.doneStates); break;
      case 'delete': deleteRow(thread, menu.doneStates); break;
      default: break;
    }
  };

  // Bundle passed down to each row for its hover cluster + right-click menu.
  const rowActions = { setRead, toggleStar, deleteRow, done: doneRow, openMenu: setContextMenu };

  return (
    <RightSidebar
      title={t('gtd.title')}
      headerAccessory={allClear ? (
        <span style={{
          marginLeft: 'auto', fontSize: 10.5, fontWeight: 600,
          color: GTD_COLORS.done, background: GTD_CHIP_BG.done,
          padding: '2px 8px', borderRadius: 9,
        }}>
          {t('gtd.inboxZero')}
        </span>
      ) : null}
      onCollapse={onCollapse}
      toggleHint={toggleHint}
    >

      {allClear ? (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', gap: 8, padding: 20, textAlign: 'center',
        }}>
          <GtdZeroPet />
          <b style={{ color: 'var(--text-primary)', fontSize: 15 }}>{t('gtd.allClear')}</b>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t('gtd.allClearHint')}</span>
        </div>
      ) : (
        sections.map(section => (
          <GtdSection
            key={section.key}
            section={section}
            collapsed={!!gtdCollapsedSections[section.key]}
            onToggle={() => toggleGtdSection(section.key)}
            onOpenTab={() => setActiveGtdTab(section.key)}
            onOpenRow={openRow}
            rowActions={rowActions}
            selectedMessageId={selectedMessageId}
            selectedMid={selectedMid}
            t={t}
          />
        ))
      )}

      {/* Portal to body: the sidebar's own wrapper carries a translateX transform (the
          collapse slide), which would otherwise capture the menu's position:fixed. */}
      {contextMenu && createPortal(
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          message={contextMenu.message}
          defaultMoveView={contextMenu.defaultMoveView}
          variant="gtdSidebar"
          onClose={() => setContextMenu(null)}
          onAction={(action, data) => handleGtdAction(action, contextMenu, data)}
        />,
        document.body,
      )}
    </RightSidebar>
  );
}

function GtdSection({ section, collapsed, onToggle, onOpenTab, onOpenRow, rowActions, selectedMessageId, selectedMid, t }) {
  const state = SECTION_STATE[section.key];
  const color = GTD_COLORS[state];
  const label = section.key === 'waiting' ? t('gtd.waiting') : t(`gtd.state.${section.key}`);

  // Only Reference is trimmed to a preview (up to 2) in the sidebar; every section
  // shows a "View all N" affordance when its total exceeds the rows on hand.
  const shown = section.key === 'reference' ? section.threads.slice(0, 2) : section.threads;
  const showViewAll = section.total > shown.length;

  return (
    <div style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      {/* The whole header row folds/unfolds its section — it must never activate an inbox
          pill (that is the "View all" link's job below). Full-row button = a big hit area. */}
      {/* Sticks directly below RightSidebar's own sticky header. The shell publishes that
          header's rendered height as --right-sidebar-header-height, so deriving the offset
          from it keeps this in lockstep if the shell's header box ever changes. */}
      <div style={{
        position: 'sticky', top: 'var(--right-sidebar-header-height, 50px)', background: 'var(--bg-secondary)', zIndex: 2, userSelect: 'none',
      }}>
        <button
          onClick={onToggle}
          aria-label={t('gtd.toggleSection', { section: label })}
          style={{
            display: 'flex', alignItems: 'center', gap: 7, width: '100%', padding: '8px 14px',
            background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', color: 'inherit',
            transition: 'all 0.1s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
        >
          <span style={{
            display: 'flex', color: 'var(--text-tertiary)', fontSize: 9, width: 10,
            transform: collapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.12s',
          }}>
            ▼
          </span>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.09em', color, textTransform: 'uppercase' }}>
            {label}
          </span>
        </button>
      </div>

      {!collapsed && (
        <div>
          {shown.map(thread => (
            <GtdThreadRow
              key={thread.id ?? thread.message_id}
              thread={thread}
              sectionKey={section.key}
              onOpen={() => onOpenRow(thread)}
              rowActions={rowActions}
              selected={isSelectedRow(thread, selectedMessageId, selectedMid)}
              t={t}
            />
          ))}
          {showViewAll && (
            <div
              onClick={onOpenTab}
              style={{ padding: '5px 24px 9px', fontSize: 11, color: 'var(--text-tertiary)', cursor: 'pointer' }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-secondary)'; }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-tertiary)'; }}
            >
              {t('gtd.viewAll', { count: section.total })} →
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function GtdThreadRow({ thread, sectionKey, onOpen, rowActions, selected, t }) {
  const isWaiting = sectionKey === 'waiting';
  // The label states this row's "done" strips: a Waiting row clears its own kinds
  // (leaving GTD labels in other sections alone); other sections clear their own state.
  const { kinds } = resolveRowDisplay(thread, sectionKey);
  const doneStates = isWaiting ? kinds : [sectionKey];

  // Open the shared context menu carrying this row's section-scoped doneStates, so its
  // "done" and "move" strip only the section the row belongs to.
  const openMenuAt = (x, y, defaultMoveView = false) =>
    rowActions.openMenu({ x, y, message: thread, doneStates, defaultMoveView });

  // The dense `sidebar` variant of the shared row, plus this surface's triage affordances:
  // a right-click menu and the hover action cluster (same buttons the inbox rows get). Both
  // stay SECTION-SCOPED via doneStates, and the sidebar only renders for GTD accounts, so the
  // "done" checkmark always shows.
  return (
    <GtdEntryRow
      thread={thread}
      sectionKey={sectionKey}
      variant="sidebar"
      selected={selected}
      t={t}
      onClick={onOpen}
      onContextMenu={e => { e.preventDefault(); openMenuAt(e.clientX, e.clientY); }}
      renderHoverActions={() => (
        <RowHoverActions
          message={thread}
          isRead={!!thread.is_read}
          background="var(--bg-tertiary)"
          onMarkRead={(e, m) => { e.stopPropagation(); rowActions.setRead(m, !m.is_read); }}
          onStar={(e, m) => { e.stopPropagation(); rowActions.toggleStar(m); }}
          onDelete={(e, m) => { e.stopPropagation(); rowActions.deleteRow(m, doneStates); }}
          onMove={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); openMenuAt(r.left, r.bottom + 4, true); }}
          onGtdDone={(e, m) => { e.stopPropagation(); rowActions.done(m, doneStates); }}
        />
      )}
    />
  );
}

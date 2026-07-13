import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useStore, selectSelectedMessageAccountId, selectSelectedMessageMid } from '../store/index.js';
import { api } from '../utils/api.js';
import {
  accountScopedMessageIdentity,
  collectThreadReadIds,
  isSelectedRow,
  openDeepLinkMessage,
} from '../utils/rightSidebar.js';
import { formatDate } from '../utils/formatDate.js';
import { resolveMessageRowTypography } from '../utils/messageRowTypography.js';
import ContextMenu from './ContextMenu.jsx';
import RightSidebar from './RightSidebar.jsx';
import RowHoverActions from './RowHoverActions.jsx';

// Fills the right-sidebar shell with one section per label folder the user picked in
// Settings, in the order they arranged them. Rows are thread heads, so acting on one
// applies to the whole thread. Each action updates its section optimistically and then
// reconciles against a debounced refetch, so a failed call can't leave a phantom row.
export default function RightSidebarLabels({ onCollapse, toggleHint }) {
  const { t } = useTranslation();
  const sections = useStore(state => state.rightSidebarSections);
  const collapsed = useStore(state => state.rightSidebarCollapsed);
  const toggleSection = useStore(state => state.toggleRightSidebarSection);
  const setThreadMessages = useStore(state => state.setThreadMessages);
  const setSelectedMessage = useStore(state => state.setSelectedMessage);
  const scheduleFetch = useStore(state => state.scheduleRightSidebarFetch);
  const removeRightSidebarThread = useStore(state => state.removeRightSidebarThread);
  const addNotification = useStore(state => state.addNotification);
  const selectedMessageId = useStore(state => state.selectedMessageId);
  const selectedMid = useStore(selectSelectedMessageMid);
  const selectedMessageAccountId = useStore(selectSelectedMessageAccountId);
  const [contextMenu, setContextMenu] = useState(null);

  const openRow = (thread) => {
    openDeepLinkMessage(thread.id, {
      getMessage: api.getMessage,
      getThread: api.getThread,
      setThreadMessages,
      setSelectedMessage,
      thread,
      onMiss: scheduleFetch,
    });
  };

  const setRead = async (thread, read) => {
    if (!!thread.is_read === read) return;
    const identity = accountScopedMessageIdentity(thread);
    const apply = (isRead) => useStore.setState(state => ({
      rightSidebarSections: (state.rightSidebarSections || []).map(section => {
        let changed = false;
        const threads = section.threads.map(row => {
          if (accountScopedMessageIdentity(row) !== identity || !!row.is_read === isRead) return row;
          changed = true;
          return { ...row, is_read: isRead };
        });
        if (!changed) return section;
        return {
          ...section,
          threads,
          unread: Math.max(0, (Number(section.unread) || 0) + (isRead ? -1 : 1)),
        };
      }),
    }));

    apply(read);
    try {
      await api.bulkRead(await collectThreadReadIds(thread, read, api.getThread), read);
      scheduleFetch();
    } catch (err) {
      console.error('Right sidebar read toggle failed:', err.message);
      apply(!read);
      // The server may have committed the flip before failing later work (the route
      // 500s after its UPDATE lands), so the rollback can be wrong — reconcile.
      scheduleFetch();
    }
  };

  const toggleStar = async (thread) => {
    const identity = accountScopedMessageIdentity(thread);
    const next = !thread.is_starred;
    const apply = (isStarred) => useStore.setState(state => ({
      rightSidebarSections: (state.rightSidebarSections || []).map(section => ({
        ...section,
        threads: section.threads.map(row =>
          accountScopedMessageIdentity(row) === identity ? { ...row, is_starred: isStarred } : row),
      })),
    }));

    apply(next);
    try {
      await api.markStarred(thread.id, next);
    } catch (err) {
      console.error('Right sidebar star toggle failed:', err.message);
      apply(!next);
      // Same partial-failure shape as setRead: the star may have committed server-side.
      scheduleFetch();
    }
  };

  const deleteRow = (thread, sectionPath) => {
    removeRightSidebarThread(thread, [sectionPath]);
    api.deleteMessage(thread.id)
      .then(scheduleFetch)
      .catch(err => {
        console.error('Right sidebar delete failed:', err.message);
        addNotification({
          title: t('messageList.deleted.failTitle'),
          body: thread.subject || t('common.noSubject'),
        });
        scheduleFetch();
      });
  };

  const moveRow = (thread, sectionPath, folder) => {
    if (!folder) return;
    removeRightSidebarThread(thread, [sectionPath]);
    api.bulkMove([thread.id], folder)
      .then(() => {
        useStore.getState().recordRecentFolder({ accountId: thread.account_id, path: folder });
        scheduleFetch();
      })
      .catch(err => {
        console.error('Right sidebar move failed:', err.message);
        addNotification({ title: t('message.moved.failTitle'), body: t('message.moved.failBody') });
        scheduleFetch();
      });
  };

  const archiveRow = (thread, sectionPath) => {
    removeRightSidebarThread(thread, [sectionPath]);
    api.bulkArchive([thread.id])
      .then(result => {
        // noArchiveFolder means the account has no archive folder mapped, so nothing
        // was actually moved server-side — same case MessageList's archive action
        // treats as a failure, not just an empty success.
        if (result.noArchiveFolder?.length) {
          addNotification({ title: t('message.archived.noFolderTitle'), body: t('message.archived.noFolderBody') });
          scheduleFetch();
          return;
        }
        scheduleFetch();
      })
      .catch(err => {
        console.error('Right sidebar archive failed:', err.message);
        addNotification({ title: t('message.archived.failTitle'), body: t('message.archived.failBody') });
        scheduleFetch();
      });
  };

  const handleAction = (action, menu, data) => {
    const { message, sectionPath } = menu;
    switch (action) {
      case 'open': openRow(message); break;
      case 'markRead': setRead(message, true); break;
      case 'markUnread': setRead(message, false); break;
      case 'toggleStar': toggleStar(message); break;
      case 'moveTo': moveRow(message, sectionPath, data); break;
      case 'archive': archiveRow(message, sectionPath); break;
      case 'delete': deleteRow(message, sectionPath); break;
      default: break;
    }
  };

  // null before the first fetch resolves — an empty array means "configured, but the
  // folders hold nothing", which is a different (and worth stating) thing.
  const loaded = sections != null;

  return (
    <RightSidebar title={t('rightSidebar.title')} onCollapse={onCollapse} toggleHint={toggleHint}>
      {loaded && sections.length === 0 ? (
        <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--text-tertiary)' }}>
          {t('rightSidebar.empty')}
        </div>
      ) : (
        (sections || []).map(section => (
          <SidebarSection
            key={section.path}
            section={section}
            collapsed={!!collapsed[section.path]}
            onToggle={() => toggleSection(section.path)}
            onOpenRow={openRow}
            onOpenMenu={setContextMenu}
            onSetRead={setRead}
            onToggleStar={toggleStar}
            onDelete={deleteRow}
            selectedMessageId={selectedMessageId}
            selectedMid={selectedMid}
            selectedMessageAccountId={selectedMessageAccountId}
            t={t}
          />
        ))
      )}

      {contextMenu && createPortal(
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          message={contextMenu.message}
          defaultMoveView={contextMenu.defaultMoveView}
          variant="rightSidebar"
          onClose={() => setContextMenu(null)}
          onAction={(action, data) => handleAction(action, contextMenu, data)}
        />,
        document.body,
      )}
    </RightSidebar>
  );
}

function SidebarSection({
  section, collapsed, onToggle, onOpenRow, onOpenMenu,
  onSetRead, onToggleStar, onDelete,
  selectedMessageId, selectedMid, selectedMessageAccountId, t,
}) {
  const label = section.name || section.path;
  const count = Number(section.unread) || Number(section.total) || 0;

  return (
    <div style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      {/* Parks beneath the shell's sticky header, whose height the shell publishes. */}
      <div style={{
        position: 'sticky', top: 'var(--right-sidebar-header-height, 50px)',
        background: 'var(--bg-secondary)', zIndex: 2, userSelect: 'none',
      }}>
        <button
          onClick={onToggle}
          aria-label={t('rightSidebar.toggleSection', { section: label })}
          style={{
            display: 'flex', alignItems: 'center', gap: 7, width: '100%', padding: '8px 14px',
            background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', color: 'inherit',
            transition: 'all 0.1s',
          }}
          onMouseEnter={event => { event.currentTarget.style.background = 'var(--bg-tertiary)'; }}
          onMouseLeave={event => { event.currentTarget.style.background = 'none'; }}
        >
          <span style={{ display: 'flex', width: 11, color: 'var(--text-tertiary)', flexShrink: 0 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <polyline points={collapsed ? '9 18 15 12 9 6' : '6 9 12 15 18 9'} />
            </svg>
          </span>
          <span style={{
            minWidth: 0, flex: 1, fontSize: 12, fontWeight: 700, letterSpacing: '0.06em',
            color: 'var(--text-primary)', textTransform: 'uppercase',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {label}
          </span>
          {/* Picked in Settings, but the folder has since gone from the server. */}
          {section.available === false && (
            <span style={{
              flexShrink: 0, padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 600,
              color: 'var(--amber)', background: 'color-mix(in srgb, var(--amber) 12%, transparent)',
            }}>
              {t('admin.rightSidebar.unavailable')}
            </span>
          )}
          <span style={{
            minWidth: 20, padding: '1px 6px', borderRadius: 8, textAlign: 'center',
            fontSize: 11, fontWeight: 600, color: 'var(--text-primary)',
            background: 'var(--bg-tertiary)',
          }}>
            {count}
          </span>
        </button>
      </div>

      {!collapsed && section.threads.map(thread => (
        <SidebarRow
          key={thread.id ?? thread.message_id}
          thread={thread}
          sectionPath={section.path}
          onOpen={() => onOpenRow(thread)}
          onOpenMenu={onOpenMenu}
          onSetRead={onSetRead}
          onToggleStar={onToggleStar}
          onDelete={onDelete}
          selected={isSelectedRow(thread, selectedMessageId, selectedMid, selectedMessageAccountId)}
          t={t}
        />
      ))}
    </div>
  );
}

function SidebarRow({
  thread, sectionPath, onOpen, onOpenMenu, onSetRead, onToggleStar, onDelete, selected, t,
}) {
  const [hovered, setHovered] = useState(false);
  const typography = resolveMessageRowTypography(!!thread.is_read);
  const sender = thread.from_name || thread.from_email || '';
  const openMenuAt = (x, y, defaultMoveView = false) =>
    onOpenMenu({ x, y, message: thread, sectionPath, defaultMoveView });

  return (
    <div
      onClick={onOpen}
      onContextMenu={event => { event.preventDefault(); openMenuAt(event.clientX, event.clientY); }}
      style={{
        position: 'relative', padding: '7px 14px 7px 32px', cursor: 'pointer',
        background: selected ? 'var(--bg-tertiary)' : 'transparent',
      }}
      onMouseEnter={event => { setHovered(true); if (!selected) event.currentTarget.style.background = 'var(--bg-hover)'; }}
      onMouseLeave={event => { setHovered(false); if (!selected) event.currentTarget.style.background = 'transparent'; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          fontSize: 12.5, ...typography.sender, flex: 1,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {sender}
        </span>
        <span style={{ fontSize: 11, ...typography.date, flexShrink: 0 }}>
          {formatDate(thread.date)}
        </span>
      </div>
      {hovered && (
        <RowHoverActions
          message={thread}
          isRead={!!thread.is_read}
          background="var(--bg-tertiary)"
          onMarkRead={(event, message) => { event.stopPropagation(); onSetRead(message, !message.is_read); }}
          onStar={(event, message) => { event.stopPropagation(); onToggleStar(message); }}
          onDelete={(event, message) => { event.stopPropagation(); onDelete(message, sectionPath); }}
          onMove={event => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            openMenuAt(rect.left, rect.bottom + 4, true);
          }}
        />
      )}
      <div style={{
        fontSize: 12, ...typography.subject, marginTop: 1,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {thread.subject || t('common.noSubject')}
      </div>
      <div style={{
        fontSize: 11.5, ...typography.preview, marginTop: 1,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {thread.snippet || ' '}
      </div>
    </div>
  );
}

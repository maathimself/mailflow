import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/index.js';
import { api } from '../../utils/api.js';
import { advanceSelectionAfterRemoval } from '../../utils/listSelection.js';
import { ActionBtn } from '../../components/RowHoverActions.jsx';
import { invalidateGtdMetadata } from './metadataStore.js';

// The GTD "done" checkmark for the row hover cluster, rendered via the 'row-hover-action' slot.
//
// Two surfaces share this button with different actions: the main message list (default here — the
// backend marks the thread read, strips every GTD label, archives the INBOX copy; optimistic like
// archive) and the GTD sidebar rows, which inject their own section-scoped `done` via ctx. When a
// `done` override is supplied it is used verbatim; otherwise the inbox-archive default runs.
export default function GtdRowDone({ message, done }) {
  const { t } = useTranslation();
  const removeMessage = useStore(s => s.removeMessage);
  const decrementUnread = useStore(s => s.decrementUnread);
  const incrementUnread = useStore(s => s.incrementUnread);
  const addNotification = useStore(s => s.addNotification);

  const inboxDone = async (e) => {
    e.stopPropagation();
    advanceSelectionAfterRemoval(message.id);
    removeMessage(message.id);
    // gtdDone marks the WHOLE thread read server-side and unreadCounts is message-based, so drop the
    // row's full thread-unread (unread_count) like scheduleDelete does — a fixed -1 under-counts a
    // multi-unread thread. Fall back to this row's own unread when absent.
    const unreadCount = Number.parseInt(message.unread_count, 10);
    const unreadDelta = Number.isFinite(unreadCount) ? unreadCount : (message.is_read ? 0 : 1);
    if (unreadDelta > 0) decrementUnread(message.account_id, unreadDelta);
    try {
      const res = await api.gtdDone(message.id);
      invalidateGtdMetadata();
      // Labels stripped but the archive step failed: the optimistic removal is still correct, but
      // the email is still in the inbox — say so rather than leave a gap.
      if (res?.archiveFailed) {
        addNotification({ title: t('gtd.doneArchiveFailed'), body: message.subject || t('common.noSubject') });
      }
    } catch (err) {
      console.error('GTD done failed:', err.message);
      useStore.getState().restoreMessages([message]);
      if (unreadDelta > 0) incrementUnread(message.account_id, unreadDelta);
      addNotification({ title: t('gtd.doneFailed'), body: message.subject || t('common.noSubject') });
    }
  };

  return (
    <ActionBtn title={t('gtd.done')} onClick={done || inboxDone}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    </ActionBtn>
  );
}

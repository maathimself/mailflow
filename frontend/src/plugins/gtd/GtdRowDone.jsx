import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/index.js';
import { api } from '../../utils/api.js';
import { advanceSelectionAfterRemoval } from '../../utils/listSelection.js';
import { ActionBtn } from '../../components/RowHoverActions.jsx';
import { doneInboxGtdMessage } from './inboxDone.js';

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
    await doneInboxGtdMessage(message, {
      advance: advanceSelectionAfterRemoval, remove: removeMessage,
      restore: useStore.getState().restoreMessages,
      decrementUnread, incrementUnread, gtdDone: api.gtdDone,
      notify: addNotification, t,
    });
  };

  return (
    <ActionBtn title={t('gtd.done')} onClick={done || inboxDone}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    </ActionBtn>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { openReplyDraft } from '../utils/openReplyDraft.js';
import { selectListedMessage } from '../utils/conversation.js';

// listRow: on a row of the list, opening the draft picks the row as a click on it does. The reading
// pane shows one on the message it has open, which a notification or a link may have parked there:
// selecting that again must leave it parked, or a message that no row holds would leave the pane.
export default function ReplyDraftIndicator({ message, listRow = false }) {
  const { t } = useTranslation();
  const status = useStore(state => state.replyDrafts[message?.id]);
  const [opening, setOpening] = useState(false);
  if (message?.folder?.toUpperCase() !== 'INBOX' || (!status?.exists && !status?.error)) return null;
  const label = status.error ? t('messageList.replyDraftRetry', 'Retry reply draft lookup')
    : t('messageList.openReplyDraft', 'Open reply draft');
  return (
    <button type="button" aria-label={label} title={status.error || label} disabled={opening}
      onClick={async event => {
        event.stopPropagation();
        if (listRow) selectListedMessage(useStore, message.id);
        else useStore.getState().setSelectedMessage(message.id);
        setOpening(true);
        try { await openReplyDraft(message.id); } finally { setOpening(false); }
      }}
      style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)',
        borderRadius: 5, padding: '2px 6px', color: 'var(--accent)', fontSize: 11,
        flexShrink: 0, cursor: opening ? 'wait' : 'pointer' }}>
      {t('messageList.replyDraft', 'Draft')}
    </button>
  );
}

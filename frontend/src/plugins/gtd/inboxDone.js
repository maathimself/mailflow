// The main-list checkmark and keyboard shortcut use the same optimistic action.
export async function doneInboxGtdMessage(message, {
  advance, remove, restore, decrementUnread, incrementUnread, gtdDone, notify, t,
}) {
  if (!message) return null;
  advance(message.id);
  remove(message.id);
  const unreadCount = Number.parseInt(message.unread_count, 10);
  const unreadDelta = Number.isFinite(unreadCount) ? unreadCount : (message.is_read ? 0 : 1);
  if (unreadDelta > 0) decrementUnread(message.account_id, unreadDelta);
  try {
    const result = await gtdDone(message.id);
    if (result?.archiveFailed) notify({ title: t('gtd.doneArchiveFailed'), body: message.subject || t('common.noSubject') });
    return result;
  } catch (error) {
    console.error('GTD done failed:', error.message);
    restore([message]);
    if (unreadDelta > 0) incrementUnread(message.account_id, unreadDelta);
    notify({ title: t('gtd.doneFailed'), body: message.subject || t('common.noSubject') });
    return null;
  }
}

// The Snoozed view's actions (#269), shared by the message list and the reading pane, so a snoozed
// message behaves the same wherever it is acted on.
import { api } from './api.js';
import { useStore } from '../store/index.js';
import { formatDateTime } from './formatDate.js';

// Where snoozed mail waits (the backend's SNOOZED_FOLDER).
export const SNOOZED_FOLDER = 'Snoozed';
export const isSnoozed = (message) => message?.folder === SNOOZED_FOLDER;

// The counts again, the snoozed count with them: the sidebar shows Snoozed only while some are.
export function refreshCounts() {
  return api.getUnreadCounts().then(counts => useStore.getState().setUnreadCounts(counts)).catch(() => {});
}

// Brings a snoozed message (and what was snoozed with it) back now. It leaves the Snoozed view at
// once and returns to it if the server could not move it.
export function unsnooze(message, { t, before } = {}) {
  const store = useStore.getState();
  before?.(message);
  store.removeMessage(message.id);
  store.addNotification({ title: t('message.unsnoozed.title'), body: message.subject || t('common.noSubject') });
  return api.unsnoozeMessage(message.id).then(() => {
    window.dispatchEvent(new CustomEvent('mailflow:refresh'));
    refreshCounts();
  }).catch((err) => {
    console.error('Unsnooze failed:', err.message);
    useStore.getState().restoreMessages([message]);
    useStore.getState().addNotification({ title: t('message.unsnoozed.failTitle'), body: t('message.unsnoozed.failBody') });
  });
}

// Moves when a snoozed message comes back. The row shows the new time at once, and the old one
// again if the server refused.
export function changeSnooze(message, untilIso, { t } = {}) {
  const store = useStore.getState();
  const previous = message.snooze_until;
  store.updateMessage(message.id, { snooze_until: untilIso });
  store.addNotification({ title: t('message.snoozeChanged.title', { when: formatDateTime(untilIso) }), body: message.subject || t('common.noSubject') });
  return api.changeSnooze(message.id, untilIso).then(() => {
    // The view is ordered by when mail comes back.
    window.dispatchEvent(new CustomEvent('mailflow:refresh'));
  }).catch((err) => {
    console.error('Change snooze failed:', err.message);
    useStore.getState().updateMessage(message.id, { snooze_until: previous });
    useStore.getState().addNotification({ title: t('message.snoozeChanged.failTitle'), body: t('message.snoozeChanged.failBody') });
  });
}

import { selectedPickerMessage } from './labelPicker.js';

const SELECTED_ACTIONS = new Set([
  'markUnread', 'forward', 'replyAllFromSelection', 'unsubscribe',
  'loadRemoteImages', 'openLabelPicker', 'reply', 'replyAll',
  'toggleStar', 'printMessage', 'toggleRead', 'selectMessage',
]);

export function canRunGlobalAction(action, { rightSidebarApplicable }) {
  return action !== 'toggleRightSidebar' || Boolean(rightSidebarApplicable);
}

export function canRunSelectedAction(action, state) {
  if (!SELECTED_ACTIONS.has(action) && !action.startsWith('gtd')) return true;
  const message = selectedPickerMessage(state);
  if (!message) return false;
  if (!action.startsWith('gtd')) return true;
  const account = (state.accounts || []).find(row => row.id === message.account_id);
  return Boolean(state.enabledPlugins?.includes('gtd') && account?.enabled && account.gtd_enabled);
}

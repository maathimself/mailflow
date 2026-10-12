import { api } from './api.js';

// Mailbox and session state that can reference the signed-out user's accounts or folders.
// Appearance and localization prefs (theme, font, layout, language) are deliberately NOT
// cleared: keeping them means the login screen and the next visit keep the last-used look
// instead of snapping back to the default dark theme (#208). They are re-synced from the
// account's server-side preferences after login.
export const SIGN_OUT_CLEARED_KEYS = [
  'mailflow_notification_sound', 'mailflow_custom_sound', 'mailflow_custom_sound_name',
  'mailflow_page_size', 'mailflow_scroll_mode', 'mailflow_sync_interval',
  'mailflow_threaded_view', 'mailflow_plaintext_email',
  'mailflow_hover_quick_actions', 'mailflow_swipe_actions',
  'mailflow_expanded_accounts', 'mailflow_collapsed_folders',
  // Reading preferences the store seeds from localStorage before loadPreferences runs.
  'mailflow_auto_open_reply_drafts', 'mailflow_after_remove',
];

// Signing out from the sidebar and from the lock screen (#523). When the session signed in
// through an SSO provider with RP-initiated logout enabled, the server returns that provider's
// end-session URL and the browser goes there, ending the SSO session too (#310); otherwise it
// goes to /login. A failed request still signs out locally.
export async function signOut({
  setUser, storage = localStorage, logout = api.logout,
  navigate = (url) => { window.location.href = url; },
}) {
  const res = await logout().catch(() => ({}));
  for (const key of SIGN_OUT_CLEARED_KEYS) storage.removeItem(key);
  setUser(null);
  navigate(res?.endSessionUrl || '/login');
}

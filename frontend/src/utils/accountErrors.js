// What to tell the user about an account's connection error, and what they can do about it.
// The server records what kind of failure it was in sync_error_code (backend
// services/accountErrorCode.js); this maps that code, never the server's text, to copy and
// actions. The raw text is still shown, under Details.
//
// Actions:
//   openOutlook  open Outlook.com, where IMAP is turned on
//   retry        connect again now
//   signIn       sign in to the provider again for this account
//   edit         open the account's settings (a password account's credentials)
//   admin        an administrator has to fix the sign-in app (Email providers)

export const OUTLOOK_WEB_URL = 'https://outlook.live.com/mail/';

// Set while a repair sign-in started in this tab is under way. The tab the provider sends back
// to inherits it (sessionStorage is copied to a tab this one opens), so that tab can trust a
// "you signed in as someone else" redirect as an answer to a repair it started.
export const REPAIR_FLAG = 'mailflow_oauth_repair';

const EMAIL_LIKE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
// The addresses from a "wrong account" sign-in result, only when this tab started a repair and
// both look like addresses. Otherwise null, and the page says something generic.
export function trustedWrongAccount(result, repairStarted) {
  if (!repairStarted || result?.error !== 'wrong_account') return null;
  const { signedInAs, expected } = result;
  const ok = (v) => typeof v === 'string' && v.length <= 320 && EMAIL_LIKE.test(v);
  return ok(signedInAs) && ok(expected) ? { signedInAs, expected } : null;
}

// Keys are spelled out in full so the locale tests can see that each one is used.
const KINDS = {
  ms_imap_disabled_personal: {
    kind: 'imapOffPersonal', labelKey: 'accountErrors.label.turnOnImap', actions: ['openOutlook', 'retry'],
    titleKey: 'accountErrors.imapOffPersonal.title', bodyKey: 'accountErrors.imapOffPersonal.body',
    stepKeys: ['accountErrors.imapOffPersonal.step1', 'accountErrors.imapOffPersonal.step2', 'accountErrors.imapOffPersonal.step3'],
    outroKey: 'accountErrors.imapOffPersonal.outro',
  },
  ms_imap_disabled_work: {
    // Only the organization's IT can turn it on, so not "Turn on IMAP".
    kind: 'imapOffWork', labelKey: 'accountErrors.label.imapOff', actions: ['retry'],
    titleKey: 'accountErrors.imapOffWork.title', bodyKey: 'accountErrors.imapOffWork.body',
  },
  oauth_reauth: {
    kind: 'signIn', labelKey: 'accountErrors.label.signInAgain', actions: ['signIn'],
    titleKey: 'accountErrors.signIn.title', titleGoogleKey: 'accountErrors.signIn.titleGoogle', bodyKey: 'accountErrors.signIn.body',
  },
  oauth_app_config: {
    // Try again for everyone: once an admin fixes the app, the account connects.
    kind: 'appConfig', labelKey: 'accountErrors.label.cantConnect', actions: ['retry', 'admin'],
    titleKey: 'accountErrors.appConfig.title',
    // The fix differs for the person who can make it.
    adminBodyKey: 'accountErrors.appConfig.bodyAdmin', userBodyKey: 'accountErrors.appConfig.bodyUser',
  },
  auth_failed: {
    kind: 'authFailed', labelKey: 'accountErrors.label.cantConnect', actions: ['edit', 'retry'],
    titleKey: 'accountErrors.authFailed.title', bodyKey: 'accountErrors.authFailed.body',
  },
  connection: {
    kind: 'connection', labelKey: 'accountErrors.label.cantConnect', actions: ['retry'],
    titleKey: 'accountErrors.connection.title', bodyKey: 'accountErrors.connection.body',
  },
};

// Providers MailFlow can sign in to again from the account itself.
const SIGN_IN_PROVIDERS = new Set(['microsoft', 'google']);

// null when the account has no error. An error with no code (recorded before the code
// existed, or a code this build does not know) reads as a generic connection problem.
export function describeAccountError(account) {
  if (!account?.sync_error) return null;
  const entry = KINDS[account.sync_error_code] || KINDS.connection;
  let { actions } = entry;
  // "Sign in again" needs a provider sign-in; a password account cannot do it, so it is
  // offered a retry instead (the code says OAuth, so this is defensive).
  if (entry.kind === 'signIn' && !SIGN_IN_PROVIDERS.has(account.oauth_provider)) actions = ['retry'];
  return {
    kind: entry.kind,
    code: account.sync_error_code || null,
    titleKey: entry.titleGoogleKey && account.oauth_provider === 'google' ? entry.titleGoogleKey : entry.titleKey,
    bodyKey: entry.bodyKey || null,
    adminBodyKey: entry.adminBodyKey || null,
    userBodyKey: entry.userBodyKey || null,
    stepKeys: entry.stepKeys || [],
    outroKey: entry.outroKey || null,
    labelKey: entry.labelKey,
    actions,
    detail: account.sync_error,
  };
}

// Whether the account's own menu should offer "Sign in again" rather than "Try again".
export function needsSignIn(account) {
  return describeAccountError(account)?.actions.includes('signIn') || false;
}

// The notice for a sign-in that ended in this tab: connected, still connecting, or the
// account's error. null when there is nothing to report.
export function signInResultNotice(result, provider) {
  if (!result?.connection) return null;
  const values = { email: result.email };
  if (result.connection === 'connected') return { type: 'info', titleKey: 'msSignIn.connected', values };
  if (result.connection === 'connecting') return { type: 'info', titleKey: 'msSignIn.stillConnecting', values };
  const info = describeAccountError({ oauth_provider: result.provider || provider, email_address: result.email, sync_error: result.error || 'error', sync_error_code: result.code });
  return { type: 'error', titleKey: info.titleKey, bodyKey: info.bodyKey || info.userBodyKey, values };
}

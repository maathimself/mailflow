// Which Microsoft Entra app a Microsoft account signs in and refreshes through (#674).
//
// MailFlow ships a registered public client so personal Outlook.com, Hotmail, Live and MSN
// accounts can connect over the device-code flow without the admin registering an app
// first. It has no secret and no redirect URI, so it only ever serves the device-code flow,
// and it signs in through the consumers tenant: work and school accounts still need the
// instance's own app. An instance's own app (MS_CLIENT_ID) takes precedence, and
// MS_BUILTIN_APP=false withdraws the built-in one entirely.
//
// A refresh token is bound to the client that obtained it, so each account records the
// client ID and tenant it was connected with and refreshes through those, not through
// whatever MS_CLIENT_ID happens to be now.

import { MAILFLOW_MS_CLIENT_ID } from './microsoftBuiltinApp.js';

export const MS_BUILTIN_TENANT_ID = 'consumers';

// A build that still carries the all-zero placeholder has no built-in app and behaves as
// if the admin had opted out.
export function msBuiltinAppShipped() {
  return !!MAILFLOW_MS_CLIENT_ID && !/^[0-]+$/.test(MAILFLOW_MS_CLIENT_ID);
}

export function msBuiltinAppEnabled() {
  if (!msBuiltinAppShipped()) return false;
  const value = (process.env.MS_BUILTIN_APP ?? '').trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(value);
}

export function getMsConfig() {
  return {
    clientId: process.env.MS_CLIENT_ID,
    clientSecret: process.env.MS_CLIENT_SECRET,
    tenantId: process.env.MS_TENANT_ID || 'common',
    redirectUri: process.env.MS_REDIRECT_URI,
  };
}

const PERSONAL_TENANTS = new Set(['common', 'consumers']);
export const ownAppAdmitsPersonal = ({ clientId, tenantId }) => !!clientId && PERSONAL_TENANTS.has(tenantId.trim().toLowerCase());
const builtinClient = () => ({ clientId: MAILFLOW_MS_CLIENT_ID, tenantId: MS_BUILTIN_TENANT_ID, builtin: true });

// Client for a new device-code sign-in, by the kind of account being added (#674):
//   'personal'  the instance's own app when its tenant admits personal accounts (common or
//               consumers), else MailFlow's built-in app unless the admin opted out
//   'work'      the instance's own app, unless it is limited to personal accounts
//   omitted     as before kinds existed: the own app when configured, else the built-in one
// Null when nothing can sign that kind of account in.
export function getMsDeviceClient(kind) {
  const config = getMsConfig();
  const own = config.clientId ? { clientId: config.clientId, tenantId: config.tenantId, builtin: false } : null;
  if (kind === 'personal') {
    if (ownAppAdmitsPersonal(config)) return own;
    return msBuiltinAppEnabled() ? builtinClient() : null;
  }
  if (kind === 'work') return msWorkAccountsAvailable() ? own : null;
  if (own) return own;
  return msBuiltinAppEnabled() ? builtinClient() : null;
}

// How a personal Microsoft account signs in now: 'own' (the instance's app admits personal
// accounts), 'shared' (MailFlow's built-in app), or null when it cannot.
export function msPersonalSignInVia() {
  const client = getMsDeviceClient('personal');
  if (!client) return null;
  return client.builtin ? 'shared' : 'own';
}

// Whether a personal Microsoft account can sign in now.
export function msPersonalAccountsAvailable() {
  return msPersonalSignInVia() !== null;
}

// Whether a work or school account can sign in now: only through the instance's own app, and
// not when that app is limited to personal accounts (the consumers tenant).
export function msWorkAccountsAvailable() {
  const { clientId, tenantId } = getMsConfig();
  return !!clientId && tenantId.trim().toLowerCase() !== 'consumers';
}

// Client a stored account refreshes through. Accounts connected before the identity was
// recorded have none and use the instance config, as they always did. The configured
// secret belongs to the configured app only: it is never offered for the built-in client
// or for an account connected with an app the instance no longer uses.
export function msRefreshClient(account) {
  const config = getMsConfig();
  const clientId = account.oauth_client_id || config.clientId;
  const tenantId = account.oauth_tenant_id || config.tenantId;
  const ownsSecret = !!clientId && clientId === config.clientId && clientId !== MAILFLOW_MS_CLIENT_ID;
  return { clientId, tenantId, clientSecret: ownsSecret ? config.clientSecret : undefined };
}

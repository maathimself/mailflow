const BASE = '/api';

// Sent on every /api request so the backend CSRF guard accepts it. A cross-site
// form/navigation cannot set a custom header, and a cross-origin fetch that tries
// triggers a CORS preflight the server rejects. Any raw fetch() to /api elsewhere
// in the app must include this same header (see CSRF_HEADER).
export const CSRF_HEADER = 'X-Requested-With';
export const CSRF_VALUE = 'MailFlow';
const messageBodyRequests = new Map();

async function request(method, path, body, extraHeaders) {
  const opts = {
    method,
    credentials: 'include',
    headers: { [CSRF_HEADER]: CSRF_VALUE, ...(extraHeaders || {}) },
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opts);
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new CustomEvent('mailflow:session_expired'));
    }
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

function getMessageBody(id, remoteImages = false) {
  const key = `${id}:${remoteImages ? 'remote' : 'blocked'}`;
  const existing = messageBodyRequests.get(key);
  if (existing) return existing;
  const promise = request('GET', `/mail/messages/${id}/body${remoteImages ? '?remoteImages=1' : ''}`)
    .finally(() => messageBodyRequests.delete(key));
  messageBodyRequests.set(key, promise);
  return promise;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body, extraHeaders) => request('POST', path, body, extraHeaders),
  put: (path, body) => request('PUT', path, body),
  patch: (path, body) => request('PATCH', path, body),
  delete: (path) => request('DELETE', path),

  // Auth
  login: (username, password) => request('POST', '/auth/login', { username, password }),
  register: (username, password, inviteToken) => request('POST', '/auth/register', { username, password, inviteToken }),
  logout: () => request('POST', '/auth/logout'),
  unlock: (password) => request('POST', '/auth/unlock', { password }),
  me: () => request('GET', '/auth/me'),
  forgotPassword: (email) => request('POST', '/auth/forgot-password', { email }),
  resetPassword: (token, password) => request('POST', '/auth/reset-password', { token, password }),
  getPreferences: () => request('GET', '/auth/preferences'),
  savePreferences: (prefs) => request('PATCH', '/auth/preferences', prefs),
  updateProfile: (data) => request('PATCH', '/auth/profile', data),
  uploadAvatar: (avatar) => request('POST', '/auth/avatar', { avatar }),
  deleteAvatar: () => request('DELETE', '/auth/avatar'),
  getRegistrationStatus: () => request('GET', '/auth/registration-status'),
  validateInvite: (token) => request('GET', `/auth/invite/${token}`),

  // Recovery email (profile security)
  getRecoveryEmail: () => request('GET', '/auth/profile/recovery-email'),
  updateRecoveryEmail: (email) => request('PATCH', '/auth/profile/recovery-email', { email }),

  // TOTP / 2FA
  totp: {
    setup: () => request('GET', '/totp/setup'),
    enable: (code) => request('POST', '/totp/enable', { code }),
    disable: (password) => request('POST', '/totp/disable', { password }),
    cancel: () => request('POST', '/totp/cancel'),
    challenge: (code, rememberDevice) => request('POST', '/auth/2fa/challenge', { code, rememberDevice }),
    sendEmailOtp: () => request('POST', '/auth/2fa/send-email-otp'),
    verifyEmailOtp: (code, rememberDevice) => request('POST', '/auth/2fa/verify-email-otp', { code, rememberDevice }),
    enrollmentSetup: () => request('GET', '/auth/2fa/enrollment/setup'),
    enrollmentEnable: (code) => request('POST', '/auth/2fa/enrollment/enable', { code }),
  },

  // Admin
  admin: {
    getUsers: (params) => request('GET', '/admin/users' + (params ? '?' + new URLSearchParams(params) : '')),
    updateUser: (id, data) => request('PATCH', `/admin/users/${id}`, data),
    deleteUser: (id) => request('DELETE', `/admin/users/${id}`),
    disableUserTotp: (id) => request('POST', `/admin/users/${id}/totp/disable`),
    getSettings: () => request('GET', '/admin/settings'),
    updateSettings: (data) => request('PATCH', '/admin/settings', data),
    getInvites: (params) => request('GET', '/admin/invites' + (params ? '?' + new URLSearchParams(params) : '')),
    createInvite: (email) => request('POST', '/admin/invites', { email }),
    deleteInvite: (id) => request('DELETE', `/admin/invites/${id}`),
    getSystemEmail: () => request('GET', '/admin/system-email'),
    saveSystemEmail: (data) => request('POST', '/admin/system-email', data),
    testSystemEmail: () => request('POST', '/admin/system-email/test'),
    deleteSystemEmail: () => request('DELETE', '/admin/system-email'),
    getAuthEvents: (params) => request('GET', '/admin/auth-events?' + new URLSearchParams(params)),
    oidc: {
      getProviders: () => request('GET', '/admin/oidc'),
      createProvider: (data) => request('POST', '/admin/oidc', data),
      updateProvider: (id, data) => request('PATCH', `/admin/oidc/${id}`, data),
      deleteProvider: (id) => request('DELETE', `/admin/oidc/${id}`),
    },
  },

  // OIDC
  oidc: {
    getProviders: () => request('GET', '/auth/oidc/providers'),
    getIdentities: () => request('GET', '/auth/oidc/identities'),
    unlinkIdentity: (id) => request('DELETE', `/auth/oidc/identities/${id}`),
  },

  // Accounts
  getAccounts: () => request('GET', '/accounts'),
  addAccount: (data) => request('POST', '/accounts', data),
  updateAccount: (id, data) => request('PUT', `/accounts/${id}`, data),
  deleteAccount: (id) => request('DELETE', `/accounts/${id}`),
  reconnectAccount: (id) => request('POST', `/accounts/${id}/reconnect`),
  reindexAccount: (id) => request('POST', `/accounts/${id}/reindex`),
  getFolders: (accountId) => request('GET', `/accounts/${accountId}/folders`),
  getAliases: (accountId) => request('GET', `/accounts/${accountId}/aliases`),
  addAlias: (accountId, data) => request('POST', `/accounts/${accountId}/aliases`, data),
  updateAlias: (accountId, aliasId, data) => request('PUT', `/accounts/${accountId}/aliases/${aliasId}`, data),
  deleteAlias: (accountId, aliasId) => request('DELETE', `/accounts/${accountId}/aliases/${aliasId}`),

  // Mail
  getMessages: (params) => {
    const qs = new URLSearchParams(params).toString();
    return request('GET', `/mail/messages?${qs}`);
  },
  getMessage: (id) => request('GET', `/mail/messages/${id}`),
  getMessageBody,
  getThread: (threadId, folder) => {
    const qs = folder ? `?folder=${encodeURIComponent(folder)}` : '';
    return request('GET', `/mail/thread/${encodeURIComponent(threadId)}${qs}`);
  },
  bulkRead: (ids, read) => request('POST', '/mail/messages/bulk-read', { ids, read }),
  markStarred: (id, starred) => request('PATCH', `/mail/messages/${id}/star`, { starred }),
  markAllRead: (accountId, folder) => request('POST', '/mail/mark-all-read', { accountId, folder }),
  deleteMessage: (id) => request('DELETE', `/mail/messages/${id}`),
  bulkDelete: (ids) => request('POST', '/mail/messages/bulk-delete', { ids }),
  bulkMove: (ids, folder) => request('POST', '/mail/messages/bulk-move', { ids, folder }),
  bulkArchive: (ids) => request('POST', '/mail/messages/bulk-archive', { ids }),
  getUnreadCounts: () => request('GET', '/mail/unread-counts'),

  // Antispam (v0.1) — manual user feedback.
  // markSpam moves the message to the account's spam/junk folder and
  // records the decision in spam_training_log. markHam moves it back to
  // INBOX. No automatic classification runs here yet.
  markSpam: (id) => request('POST', `/mail/messages/${id}/spam`),
  markHam:  (id) => request('POST', `/mail/messages/${id}/ham`),

  getMessageHeaders: (id) => request('GET', `/mail/messages/${id}/headers`),
  snoozeMessage: (id, until) => request('POST', `/mail/messages/${id}/snooze`, { until }),

  // Integrations
  getIntegrations: () => request('GET', '/integrations'),
  saveIntegration: (provider, config) => request('POST', `/integrations/${provider}`, config),
  deleteIntegration: (provider) => request('DELETE', `/integrations/${provider}`),
  startMsDeviceFlow: async () => {
    const res = await fetch('/oauth/microsoft/device', { method: 'POST', credentials: 'include' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to start device code flow');
    return data;
  },
  pollMsDeviceFlow: async () => {
    const res = await fetch('/oauth/microsoft/device/poll', { credentials: 'include' });
    return res.json();
  },

  // Sync
  syncNow: (accountId) => request('POST', '/mail/sync', accountId ? { accountId } : {}),
  syncFolder: (accountId, folder) => request('POST', '/mail/sync-folder', { accountId, folder }),

  // Folder management
  createFolder: (accountId, name, parentPath) => request('POST', '/mail/folders', { accountId, name, parentPath }),
  deleteFolder: (accountId, path) => request('POST', '/mail/folders/delete', { accountId, path }),
  renameFolder: (accountId, oldPath, newName) => request('POST', '/mail/folders/rename', { accountId, oldPath, newName }),
  emptyFolder: (accountId, path) => request('POST', '/mail/folders/empty', { accountId, path }),

  // Search
  search: (q, accountId, { offset = 0, limit, folder } = {}) => {
    const params = new URLSearchParams({ q });
    if (accountId) params.set('accountId', accountId);
    if (limit) params.set('limit', limit);
    if (folder) params.set('folder', folder);
    if (offset) params.set('offset', offset);
    return request('GET', `/search?${params}`);
  },
  suggestContacts: (q) => request('GET', `/search/contacts?q=${encodeURIComponent(q)}`),

  // Contacts
  getContacts:   ({ q, limit, offset, is_auto } = {}) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (limit !== undefined) p.set('limit', limit);
    if (offset !== undefined) p.set('offset', offset);
    if (is_auto !== undefined) p.set('is_auto', is_auto);
    const qs = p.toString();
    return request('GET', `/contacts${qs ? '?' + qs : ''}`);
  },
  getContact:    (id)       => request('GET',    `/contacts/${id}`),
  createContact: (data)     => request('POST',   '/contacts', data),
  updateContact: (id, data) => request('PATCH',  `/contacts/${id}`, data),
  deleteContact: (id)       => request('DELETE', `/contacts/${id}`),

  // CardDAV contact sync (Nextcloud etc.)
  carddav: {
    status:     ()     => request('GET',    '/carddav'),
    connect:    (data) => request('POST',   '/carddav/connect', data),
    update:     (data) => request('PATCH',  '/carddav', data),
    sync:       ()     => request('POST',   '/carddav/sync'),
    disconnect: ()     => request('DELETE', '/carddav'),
  },

  // Image whitelist
  addToImageWhitelist: (entry) => request('POST', '/auth/preferences/whitelist-add', entry),

  // Web Push
  getPushVapidKey:  ()           => request('GET',    '/auth/push/vapid-key'),
  pushSubscribe:    (subscription) => request('POST',   '/auth/push/subscribe',    subscription),
  pushUnsubscribe:  (body)       => request('POST',    '/auth/push/unsubscribe',   body),

  // Inbox Rules
  getRules:    ()         => request('GET',    '/rules'),
  createRule:  (data)     => request('POST',   '/rules', data),
  updateRule:  (id, data) => request('PUT',    `/rules/${id}`, data),
  deleteRule:  (id)       => request('DELETE', `/rules/${id}`),
  reorderRules:(ids)      => request('PATCH',  '/rules/reorder', { ids }),
  runRules:    (accountId) => request('POST',  '/rules/run', accountId ? { accountId } : {}),

  // Drafts
  saveDraft:   (data)              => request('POST',   '/mail/draft', data),
  deleteDraft: (accountId, uid, folder) =>
    request('DELETE', `/mail/draft/${uid}?accountId=${encodeURIComponent(accountId)}&folder=${encodeURIComponent(folder)}`),

  // Block List
  getBlockList:          ()      => request('GET',    '/block-list'),
  addToBlockList:        (email) => request('POST',   '/block-list', { emailAddress: email }),
  removeFromBlockList:   (id)    => request('DELETE', `/block-list/${id}`),

  // AI assistant
  ai: {
    getConfig: () => request('GET', '/admin/ai'),
    saveConfig: (data) => request('PATCH', '/admin/ai', data),
    deleteConfig: () => request('DELETE', '/admin/ai'),
    test: () => request('POST', '/admin/ai/test'),
    status: () => request('GET', '/ai/status'),
  },

  // Category counts for inbox tab badges
  getCategoryCounts: (params) => {
    const qs = new URLSearchParams(params || {}).toString();
    return request('GET', `/mail/category-counts${qs ? '?' + qs : ''}`);
  },

  // Manual category override for a single message
  setMessageCategory: (id, category) => request('PATCH', `/mail/messages/${id}/category`, { category }),

  // Trigger unsubscribe for a newsletter message
  unsubscribeMessage: (id) => request('POST', `/mail/messages/${id}/unsubscribe`),

  // Email categorization
  categories: {
    getSources: () => request('GET', '/categories/sources'),
    addSource: (data) => request('POST', '/categories/sources', data),
    toggleSource: (id, enabled) => request('PATCH', `/categories/sources/${id}`, { enabled }),
    deleteSource: (id) => request('DELETE', `/categories/sources/${id}`),
    refreshSource: (id) => request('POST', `/categories/sources/${id}/refresh`),
    recategorize: (accountId) => request('POST', `/categories/recategorize/${accountId}`),
    aiClassify: (messageId) => request('POST', `/categories/ai-classify/${messageId}`),
  },

  // Todoist integration
  todoist: {
    status:       ()       => request('GET',    '/todoist/status'),
    connect:      (token)  => request('POST',   '/todoist/connect', { token }),
    disconnect:   ()       => request('DELETE', '/todoist/disconnect'),
    getProjects:  ()       => request('GET',    '/todoist/projects'),
    getLabels:    ()       => request('GET',    '/todoist/labels'),
    createTask:   (data)   => request('POST',   '/todoist/tasks', data),
  },
};

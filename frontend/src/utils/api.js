const BASE = '/api';

async function request(method, path, body) {
  const opts = {
    method,
    credentials: 'include',
    headers: {},
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  patch: (path, body) => request('PATCH', path, body),
  delete: (path) => request('DELETE', path),

  // Auth
  login: (username, password) => request('POST', '/auth/login', { username, password }),
  register: (username, password, inviteToken) => request('POST', '/auth/register', { username, password, inviteToken }),
  logout: () => request('POST', '/auth/logout'),
  me: () => request('GET', '/auth/me'),
  getPreferences: () => request('GET', '/auth/preferences'),
  savePreferences: (prefs) => request('PATCH', '/auth/preferences', prefs),
  getRegistrationStatus: () => request('GET', '/auth/registration-status'),
  validateInvite: (token) => request('GET', `/auth/invite/${token}`),

  // TOTP / 2FA
  totp: {
    setup: () => request('GET', '/totp/setup'),
    enable: (code) => request('POST', '/totp/enable', { code }),
    disable: (password) => request('POST', '/totp/disable', { password }),
    challenge: (code) => request('POST', '/auth/2fa/challenge', { code }),
  },

  // Admin
  admin: {
    getUsers: () => request('GET', '/admin/users'),
    updateUser: (id, data) => request('PATCH', `/admin/users/${id}`, data),
    deleteUser: (id) => request('DELETE', `/admin/users/${id}`),
    getSettings: () => request('GET', '/admin/settings'),
    updateSettings: (data) => request('PATCH', '/admin/settings', data),
    getInvites: () => request('GET', '/admin/invites'),
    createInvite: (email) => request('POST', '/admin/invites', { email }),
    deleteInvite: (id) => request('DELETE', `/admin/invites/${id}`),
  },

  // Accounts
  getAccounts: () => request('GET', '/accounts'),
  addAccount: (data) => request('POST', '/accounts', data),
  updateAccount: (id, data) => request('PUT', `/accounts/${id}`, data),
  deleteAccount: (id) => request('DELETE', `/accounts/${id}`),
  reconnectAccount: (id) => request('POST', `/accounts/${id}/reconnect`),
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
  getMessageBody: (id, remoteImages = false) =>
    request('GET', `/mail/messages/${id}/body${remoteImages ? '?remoteImages=1' : ''}`),
  markRead: (id, read) => request('PATCH', `/mail/messages/${id}/read`, { read }),
  markStarred: (id, starred) => request('PATCH', `/mail/messages/${id}/star`, { starred }),
  markAllRead: (accountId, folder) => request('POST', '/mail/mark-all-read', { accountId, folder }),
  deleteMessage: (id) => request('DELETE', `/mail/messages/${id}`),
  bulkDelete: (ids) => request('POST', '/mail/messages/bulk-delete', { ids }),
  bulkMove: (ids, folder) => request('POST', '/mail/messages/bulk-move', { ids, folder }),
  bulkArchive: (ids) => request('POST', '/mail/messages/bulk-archive', { ids }),
  getUnreadCounts: () => request('GET', '/mail/unread-counts'),

  getMessageHeaders: (id) => request('GET', `/mail/messages/${id}/headers`),

  // Integrations
  getIntegrations: () => request('GET', '/integrations'),
  saveIntegration: (provider, config) => request('POST', `/integrations/${provider}`, config),
  deleteIntegration: (provider) => request('DELETE', `/integrations/${provider}`),

  // Sync
  syncNow: (accountId) => request('POST', '/mail/sync', accountId ? { accountId } : {}),
  syncFolder: (accountId, folder) => request('POST', '/mail/sync-folder', { accountId, folder }),

  // Folder management
  createFolder: (accountId, name, parentPath) => request('POST', '/mail/folders', { accountId, name, parentPath }),
  deleteFolder: (accountId, path) => request('POST', '/mail/folders/delete', { accountId, path }),
  renameFolder: (accountId, oldPath, newName) => request('POST', '/mail/folders/rename', { accountId, oldPath, newName }),
  emptyFolder: (accountId, path) => request('POST', '/mail/folders/empty', { accountId, path }),

  // Search
  search: (q, accountId, { offset = 0 } = {}) => {
    const params = new URLSearchParams({ q });
    if (accountId) params.set('accountId', accountId);
    if (offset) params.set('offset', offset);
    return request('GET', `/search?${params}`);
  },
};

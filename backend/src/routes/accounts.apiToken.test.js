import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'u1' };
    if (req.get('x-test-token')) req.apiToken = { id: 't1', userId: 'u1', scopes: ['read'] };
    next();
  },
}));
vi.mock('../index.js', () => ({ imapManager: {} }));

import express from 'express';
import { query } from '../services/db.js';
import { pluginRegistry } from '../plugins/registry.js';
import accountRoutes, { SAFE_FIELDS } from './accounts.js';

const ACCOUNT = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Work', sender_name: 'Maria Silva', email_address: 'maria@example.com',
  color: '#7c6af7', icon: null, protocol: 'imap', imap_host: 'imap.example.com', imap_port: 993, imap_tls: true,
  imap_skip_tls_verify: false, smtp_host: 'smtp.example.com', smtp_port: 587, smtp_tls: 'STARTTLS', auth_user: 'maria',
  smtp_auth_user: 'maria', oauth_provider: null, oauth_public_client: false, enabled: true, include_in_unified_inbox: true,
  last_sync: new Date('2026-10-14T10:00:00Z'), sync_error: null, sync_error_code: null, sort_order: 0, folder_mappings: { archive: 'Archive' },
  signature: '<p>Maria</p>', signature_enabled: true,
  created_at: new Date('2026-01-01T00:00:00Z'), categorization_enabled: true, antispam_enabled: true, trusted_authserv_id: 'mx.example.com',
  auto_cc_addresses: [], auto_bcc_addresses: ['archive@example.com'],
};
const ALIAS = { id: '22222222-2222-4222-8222-222222222222', account_id: ACCOUNT.id, name: 'Sales', email: 'sales@example.com',
  reply_to: null, signature: '<p>Sales</p>', created_at: new Date('2026-02-01T00:00:00Z') };

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use('/api/accounts', accountRoutes);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

let enrich;
beforeEach(() => {
  query.mockReset().mockImplementation(async sql => ({ rows: sql.includes('FROM account_aliases') ? [ALIAS] : [ACCOUNT] }));
  enrich = vi.spyOn(pluginRegistry, 'collectHook').mockResolvedValue([{ gtd_enabled: false, gtd_folders: {} }]);
});

describe('GET /api/accounts', () => {
  it('gives an API token what it needs to name an account and draft from it, and none of its settings', async () => {
    const res = await fetch(`${base}/api/accounts`, { headers: { 'x-test-token': '1' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{
      id: ACCOUNT.id, name: 'Work', sender_name: 'Maria Silva', email_address: 'maria@example.com', color: '#7c6af7', icon: null,
      enabled: true, include_in_unified_inbox: true, last_sync: '2026-10-14T10:00:00.000Z', sync_error: null,
      signature_enabled: true, auto_cc_addresses: [], auto_bcc_addresses: ['archive@example.com'],
      aliases: [{ id: ALIAS.id, name: 'Sales', email: 'sales@example.com', reply_to: null }],
    }]);
    // Plugin settings are not asked for either.
    expect(enrich).not.toHaveBeenCalled();
  });

  it('still gives the browser the whole account', async () => {
    const [account] = await (await fetch(`${base}/api/accounts`)).json();
    for (const field of SAFE_FIELDS) expect(account, field).toHaveProperty(field);
    expect(account).toMatchObject({ imap_host: 'imap.example.com', auth_user: 'maria', folder_mappings: { archive: 'Archive' }, gtd_enabled: false });
    expect(account.aliases[0]).toMatchObject({ account_id: ACCOUNT.id, signature: expect.stringContaining('Sales') });
  });
});

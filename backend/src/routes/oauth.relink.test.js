import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  imapManager: { clearConnectCooldown: vi.fn(), connectAccount: vi.fn() },
  withTransaction: vi.fn(),
  jwtVerify: vi.fn(),
}));

// oauth.js imports imapManager from ../index.js, which has heavy load-time side
// effects (Redis connect, migrations). Mock it so importing oauth.js is inert.
vi.mock('../index.js', () => ({ imapManager: mocks.imapManager }));
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: mocks.withTransaction }));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => v, decrypt: (v) => v }));
// Verifying a real id_token would need the provider's published signing keys.
vi.mock('jose', () => ({ createRemoteJWKSet: vi.fn(() => ({})), jwtVerify: mocks.jwtVerify }));

import express from 'express';
import oauthRoutes from './oauth.js';

// The test reaches the app with the real fetch. The stubbed global one answers the
// provider token endpoints that oauth.js calls.
const realFetch = globalThis.fetch;

// Mailboxes that were added with a password and are now being linked through OAuth.
const OUTLOOK_ROW = {
  id: 'acc-1',
  user_id: 'user-1',
  email_address: 'me@outlook.com',
  imap_host: 'outlook.office365.com',
  oauth_provider: null,
  auth_user: 'me@outlook.com',
  auth_pass: 'old-password',
};
const GMAIL_ROW = { ...OUTLOOK_ROW, email_address: 'me@gmail.com', imap_host: 'imap.gmail.com', auth_user: 'me@gmail.com' };

function buildApp() {
  const app = express();
  // The callback checks the CSRF nonce and takes the linking user from the session.
  app.use((req, _res, next) => {
    req.session = { userId: 'user-1', oauthNonce: 'nonce-1', oauthUserId: 'user-1' };
    next();
  });
  app.use('/oauth', oauthRoutes);
  return app;
}

describe('OAuth re-link of an existing account', () => {
  let server;
  let base;
  let existingRow; // the account the signed-in address already belongs to
  let statements; // SQL run inside the upsert transaction, in order

  beforeAll(async () => {
    await new Promise(resolve => {
      server = buildApp().listen(0, resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    existingRow = OUTLOOK_ROW;
    statements = [];
    const client = {
      query: vi.fn(async (sql) => {
        statements.push(sql);
        const select = sql.match(/SELECT ([\w\s,*]+?) FROM email_accounts WHERE (?:user_id|id) =/);
        if (!select) return { rows: [] };
        // Only the named columns, as PostgreSQL returns them. The whole row would hide a
        // SELECT that stopped reading a column the code needs.
        const cols = select[1].split(',').map(c => c.trim());
        return { rows: [cols.includes('*') ? existingRow : Object.fromEntries(cols.map(c => [c, existingRow[c]]))] };
      }),
    };
    mocks.withTransaction.mockReset();
    mocks.withTransaction.mockImplementation(fn => fn(client));
    mocks.jwtVerify.mockReset();
    mocks.jwtVerify.mockImplementation(async () => ({
      payload: { email: existingRow.email_address, name: 'Me', email_verified: true },
    }));
    mocks.imapManager.clearConnectCooldown.mockReset();
    mocks.imapManager.connectAccount.mockReset();
    mocks.imapManager.connectAccount.mockResolvedValue(true);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: 'idt' }),
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function callback(provider) {
    const res = await realFetch(`${base}/oauth/${provider}/callback?code=c&state=nonce-1`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    return res.headers.get('location');
  }

  // Everything that picks password or XOAUTH2 reads oauth_provider. Left NULL, the row
  // stores the new tokens and goes on logging in with the old password. An account already
  // on Microsoft OAuth is Microsoft whatever its host, as it is to providerProfile().
  it.each([
    ['an Outlook password account', OUTLOOK_ROW],
    ['a Microsoft OAuth account on a custom host', { ...OUTLOOK_ROW, imap_host: 'mail.example.com', oauth_provider: 'microsoft' }],
  ])('sets oauth_provider when a Microsoft sign-in re-links %s', async (_label, row) => {
    existingRow = row;
    expect(await callback('microsoft')).toBe('/?oauth_success=microsoft');

    const update = statements.find(sql => /UPDATE email_accounts/.test(sql));
    const setList = update?.match(/SET([\s\S]*?)WHERE/)?.[1];
    expect(setList).toMatch(/oauth_provider\s*=\s*'microsoft'/);

    // The connect gets the row as the UPDATE left it, read back after it.
    const reread = statements.findLastIndex(sql => /SELECT \* FROM email_accounts WHERE id =/.test(sql));
    expect(reread).toBeGreaterThan(statements.indexOf(update));
    expect(mocks.imapManager.connectAccount).toHaveBeenCalledWith(existingRow);
  });

  // An auth failure backs the account off for up to six hours, and connectAccount returns
  // early until it expires. The stand-in keeps that contract: only clearConnectCooldown
  // lifts the backoff.
  it.each([
    ['microsoft', OUTLOOK_ROW],
    ['google', GMAIL_ROW],
  ])('clears the connect backoff before reconnecting (%s)', async (provider, row) => {
    existingRow = row;
    const backedOff = new Set([row.id]);
    const connected = [];
    mocks.imapManager.clearConnectCooldown.mockImplementation(id => { backedOff.delete(id); });
    mocks.imapManager.connectAccount.mockImplementation(async (account) => {
      if (backedOff.has(account.id)) return false;
      connected.push(account.id);
      return true;
    });

    expect(await callback(provider)).toBe(`/?oauth_success=${provider}`);

    expect(connected).toEqual([row.id]);
  });

  // A Microsoft account's sign-in name can be a Gmail address. Switched to XOAUTH2, that
  // Gmail account would stop logging in, with no setting to switch it back.
  it.each([
    ['a Gmail password account', GMAIL_ROW],
    ['a Google OAuth account', { ...GMAIL_ROW, oauth_provider: 'google' }],
  ])('leaves %s alone when a Microsoft sign-in has its address', async (_label, row) => {
    existingRow = row;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    // The user is told why, rather than that the Microsoft sign-in itself failed.
    const location = await callback('microsoft');
    expect(new URLSearchParams(location.slice(2)).get('oauth_error')).toMatch(/non-Microsoft mail server/);

    expect(logged).toHaveBeenCalledWith('Microsoft OAuth callback error:',
      expect.objectContaining({ message: expect.stringMatching(/non-Microsoft mail server/) }));
    expect(statements.some(sql => /UPDATE email_accounts/.test(sql))).toBe(false);
    expect(mocks.imapManager.connectAccount).not.toHaveBeenCalled();
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The account, alias, message and contact checks in the accounts, rules, spam, draft,
// categories and contacts routes, which go through services/ownership.js: another user's
// resource is refused with the status and body it always was, before anything is written or
// sent to IMAP, and the owner gets past the check. (Mail routes: mail.ownership.test.js.)
const session = vi.hoisted(() => ({ userId: 'owner' }));
const imap = vi.hoisted(() => {
  const fns = {};
  const manager = new Proxy(fns, {
    get(target, prop) {
      if (!(prop in target)) target[prop] = vi.fn(() => Promise.resolve(undefined));
      return target[prop];
    },
  });
  return { fns, manager };
});
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => {
  const signIn = (req, _res, next) => { req.session = { userId: session.userId }; next(); };
  return { requireAuth: signIn, requireAdmin: signIn };
});
vi.mock('../index.js', () => ({ imapManager: imap.manager }));
vi.mock('../services/aiAccess.js', () => ({ getUserAiAccess: vi.fn(async () => ({ allowed: true })) }));
vi.mock('../services/categorizer.js', () => ({
  invalidateSocialDomainCache: vi.fn(), backfillCategories: vi.fn(async () => {}),
  aiClassifyMessage: vi.fn(async () => 'newsletter'), BUILTIN_SETS: {},
}));
vi.mock('../services/spamAuthservIds.js', () => ({ detectAuthservIds: vi.fn(async () => ({ analyzed: 0, detected: [] })) }));
// The real lookups, watched, so each route's columns and filters can be pinned.
vi.mock('../services/ownership.js', async (importOriginal) => {
  const real = await importOriginal();
  const watched = ['findOwnedAccount', 'findOwnedMessage', 'findOwnedMessages', 'findOwnedAlias', 'findOwnedContact', 'findOwnedAddressBook'];
  return { ...real, ...Object.fromEntries(watched.map(name => [name, vi.fn(real[name])])) };
});

import express from 'express';
import accountRoutes from './accounts.js';
import rulesRoutes from './rules.js';
import spamRoutes, { accountSpamRouter } from './spam.js';
import draftRoutes from './draft.js';
import categoriesRoutes from './categories.js';
import contactsRoutes from './contacts.js';
import { query } from '../services/db.js';
import * as ownership from '../services/ownership.js';

const OWNER = 'owner';
const STRANGER = 'stranger';
const ACCOUNT_ID = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const SECOND_ACCOUNT_ID = 'a2a2a2a2-2222-4222-8222-a2a2a2a2a2a2';
const ALIAS_ID = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';
const MESSAGE_ID = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
const CONTACT_ID = 'd4d4d4d4-4444-4444-8444-d4d4d4d4d4d4';
const BOOK_ID = 'e5e5e5e5-5555-4555-8555-e5e5e5e5e5e5';

const ACCOUNTS = {
  [ACCOUNT_ID]: { id: ACCOUNT_ID, user_id: OWNER, name: 'Me', email_address: 'me@example.com', protocol: 'imap', enabled: true, folder_mappings: { drafts: 'Drafts' }, oauth_provider: null, trusted_authserv_id: 'mx.example' },
  [SECOND_ACCOUNT_ID]: { id: SECOND_ACCOUNT_ID, user_id: OWNER, name: 'Me too', email_address: 'me2@example.com', protocol: 'imap', enabled: true, folder_mappings: { drafts: 'Drafts' }, oauth_provider: null },
};
const message = () => ({ id: MESSAGE_ID, account_id: ACCOUNT_ID, uid: 7, folder: 'INBOX', message_id: '<m1@example.com>', subject: 'Weekly', from_email: 'news@example.com', snippet: 'Hi', spam_details: null, owner_id: OWNER, folder_mappings: {} });
const contact = () => ({ id: CONTACT_ID, uid: 'u-1', user_id: OWNER, address_book_id: BOOK_ID, display_name: 'Ann', first_name: null, last_name: null, primary_email: 'ann@example.com', emails: [{ value: 'ann@example.com' }], phones: [], organization: null, notes: null, source: 'local', book_source: 'local', read_only: false });

const flat = sql => sql.replace(/\s+/g, ' ').trim();
let writes;
function fakeQuery(rawSql, params = []) {
  const sql = flat(rawSql);
  const result = rows => Promise.resolve({ rows, rowCount: rows.length });
  if (/^(UPDATE|DELETE|INSERT)\b/.test(sql)) writes.push(sql);
  if (/^SELECT .+ FROM email_accounts WHERE id = \$1 AND user_id = \$2/.test(sql)) {
    const account = ACCOUNTS[params[0]];
    const ok = account && account.user_id === params[1]
      && (!sql.includes('enabled = true') || account.enabled)
      && (!sql.includes('protocol = $3') || account.protocol === params[2]);
    return result(ok ? [{ ...account }] : []);
  }
  if (sql.includes('FROM account_aliases a JOIN email_accounts e ON a.account_id = e.id WHERE a.id = $1 AND e.user_id = $2 AND e.id = $3')) {
    return result(params[0] === ALIAS_ID && params[1] === OWNER && params[2] === ACCOUNT_ID ? [{ id: ALIAS_ID, account_id: ACCOUNT_ID }] : []);
  }
  if (/FROM messages m JOIN email_accounts a ON (m\.account_id = a\.id|a\.id = m\.account_id) WHERE m\.id = \$1 AND a\.user_id = \$2/.test(sql)) {
    return result(params[0] === MESSAGE_ID && params[1] === OWNER ? [message()] : []);
  }
  if (sql.includes('FROM contacts c JOIN address_books ab ON ab.id = c.address_book_id WHERE c.id = $1 AND c.user_id = $2')) {
    return result(params[0] === CONTACT_ID && params[1] === OWNER ? [contact()] : []);
  }
  if (sql.startsWith('SELECT * FROM email_accounts WHERE id = $1')) return result(ACCOUNTS[params[0]] ? [{ ...ACCOUNTS[params[0]] }] : []);
  if (sql.startsWith('SELECT message_id FROM messages WHERE account_id = $1 AND uid = $2')) return result([{ message_id: '<old@example.com>' }]);
  if (/COUNT\(\*\)|count\(\*\)|MIN\(priority\)/.test(sql)) return result([{ cnt: '0', count: '0', n: 0, enabled_n: 0, lo: 0, hi: -1 }]);
  if (/^(INSERT|UPDATE|DELETE) .*RETURNING/.test(sql)) return result([{ id: 'new-row', address_book_id: BOOK_ID }]);
  return result([]);
}

let server, base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/accounts', accountRoutes);
  app.use('/api/accounts', accountSpamRouter);
  app.use('/api/spam', spamRoutes);
  app.use('/api/mail', draftRoutes);
  app.use('/api/rules', rulesRoutes);
  app.use('/api/contacts', contactsRoutes);
  app.use('/api', categoriesRoutes);
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
afterAll(() => new Promise(r => server.close(r)));

beforeEach(() => {
  writes = [];
  vi.mocked(ownership.findOwnedAccount).mockClear();
  vi.mocked(ownership.findOwnedMessage).mockClear();
  vi.mocked(ownership.findOwnedAlias).mockClear();
  vi.mocked(ownership.findOwnedContact).mockClear();
  query.mockReset().mockImplementation(fakeQuery);
  for (const key of Object.keys(imap.fns)) delete imap.fns[key];
  Object.assign(imap.fns, {
    broadcast: vi.fn(),
    clearConnectCooldown: vi.fn(),
    disconnectAccount: vi.fn(() => Promise.resolve()),
    connectAccount: vi.fn(() => Promise.resolve(true)),
    backfillAllRunning: new Set(),
    backfillAllFolders: vi.fn(() => Promise.resolve()),
    appendToFolder: vi.fn(() => Promise.resolve({ uid: 12 })),
    upsertDraftMessageRecord: vi.fn(() => Promise.resolve()),
    permanentDeleteMessage: vi.fn(() => Promise.resolve(true)),
  });
});

async function call(userId, { method = 'GET', path, body }) {
  session.userId = userId;
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json };
}

const imapCalls = () => Object.entries(imap.fns).filter(([, fn]) => fn.mock?.calls.length).map(([name]) => name);
const accountNotFound = { status: 404, json: { error: 'Account not found' } };
const messageNotFound = { status: 404, json: { error: 'Message not found' } };
const contactNotFound = { status: 404, json: { error: 'Contact not found' } };
const aliasNotFound = { status: 404, json: { error: 'Alias not found' } };
const rule = { name: 'r', accountId: ACCOUNT_ID, conditions: [{ field: 'subject', operator: 'contains', value: 'x' }], actions: [{ type: 'mark_read' }] };
const draft = { accountId: ACCOUNT_ID, to: [], subject: 'Hi', body: 'Hello' };

// [name, request, refusal for another user's resource, what the owner gets past the check]
const cases = [
  ['PUT /accounts/:id', { method: 'PUT', path: `/accounts/${ACCOUNT_ID}`, body: { name: 'New name' } }, accountNotFound, { status: 200 }],
  ['DELETE /accounts/:id', { method: 'DELETE', path: `/accounts/${ACCOUNT_ID}` }, accountNotFound, { status: 200, json: { ok: true } }],
  ['POST /accounts/:id/reconnect', { method: 'POST', path: `/accounts/${ACCOUNT_ID}/reconnect` }, accountNotFound, { status: 200, json: { ok: true } }],
  ['GET /accounts/:id/aliases', { path: `/accounts/${ACCOUNT_ID}/aliases` }, accountNotFound, { status: 200, json: [] }],
  ['POST /accounts/:id/aliases', { method: 'POST', path: `/accounts/${ACCOUNT_ID}/aliases`, body: { name: 'A', email: 'a@example.com' } }, accountNotFound, { status: 200 }],
  ['PUT /accounts/:id/aliases/:aliasId', { method: 'PUT', path: `/accounts/${ACCOUNT_ID}/aliases/${ALIAS_ID}`, body: { name: 'A', email: 'a@example.com' } }, aliasNotFound, { status: 200 }],
  ['DELETE /accounts/:id/aliases/:aliasId', { method: 'DELETE', path: `/accounts/${ACCOUNT_ID}/aliases/${ALIAS_ID}` }, aliasNotFound, { status: 200, json: { ok: true } }],
  ['GET /accounts/:id/folders', { path: `/accounts/${ACCOUNT_ID}/folders` }, accountNotFound, { status: 200, json: [] }],
  ['POST /accounts/:id/reindex', { method: 'POST', path: `/accounts/${ACCOUNT_ID}/reindex` }, accountNotFound, { status: 200, json: { ok: true, alreadyRunning: false } }],
  ['POST /accounts/:id/spam/reset-training', { method: 'POST', path: `/accounts/${ACCOUNT_ID}/spam/reset-training`, body: { confirm: true } }, accountNotFound, { status: 200 }],
  ['GET /spam/authserv-ids', { path: `/spam/authserv-ids?accountId=${ACCOUNT_ID}` }, accountNotFound, { status: 200, json: { accountId: ACCOUNT_ID, trustedAuthservId: 'mx.example', analyzed: 0, detected: [] } }],
  ['GET /spam/explain', { path: `/spam/explain?messageId=${MESSAGE_ID}` }, messageNotFound, { status: 200 }],
  ['POST /rules/run', { method: 'POST', path: '/rules/run', body: { accountId: ACCOUNT_ID } }, accountNotFound, { status: 202 }],
  ['POST /rules', { method: 'POST', path: '/rules', body: rule }, { status: 403, json: { error: 'Account not found' } }, { status: 201 }],
  ['PUT /rules/:id', { method: 'PUT', path: `/rules/${ALIAS_ID}`, body: rule }, { status: 403, json: { error: 'Account not found' } }, { status: 200 }],
  ['POST /rules/sender-category', { method: 'POST', path: '/rules/sender-category', body: { messageId: MESSAGE_ID, scope: 'sender', category: 'newsletter' } }, messageNotFound, { status: 200 }],
  ['POST /mail/draft', { method: 'POST', path: '/mail/draft', body: draft }, accountNotFound, { status: 200, json: { uid: 12, folder: 'Drafts' } }],
  ['DELETE /mail/draft/:uid', { method: 'DELETE', path: `/mail/draft/5?accountId=${ACCOUNT_ID}&folder=Drafts` }, accountNotFound, { status: 200, json: { ok: true } }],
  ['POST /categories/ai-classify/:messageId', { method: 'POST', path: `/categories/ai-classify/${MESSAGE_ID}` }, messageNotFound, { status: 200, json: { ok: true, category: 'newsletter' } }],
  ['GET /contacts/:id', { path: `/contacts/${CONTACT_ID}` }, contactNotFound, { status: 200 }],
  ['PATCH /contacts/:id', { method: 'PATCH', path: `/contacts/${CONTACT_ID}`, body: { displayName: 'Anne' } }, contactNotFound, { status: 200 }],
  ['DELETE /contacts/:id', { method: 'DELETE', path: `/contacts/${CONTACT_ID}` }, contactNotFound, { status: 200, json: { ok: true } }],
];

describe('routes refuse another user\'s account, alias, message or contact', () => {
  it.each(cases)('%s', async (_name, request, refusal) => {
    const res = await call(STRANGER, request);
    expect(res).toEqual(refusal);
    expect(writes).toEqual([]);
    expect(imapCalls()).toEqual([]);
  });
});

describe('routes still serve the owner', () => {
  it.each(cases)('%s', async (_name, request, refusal, owner) => {
    const res = await call(OWNER, request);
    expect(res).not.toEqual(refusal);
    expect(res.status).toBe(owner.status);
    if (owner.json) expect(res.json).toEqual(owner.json);
  });
});

describe('replacing a draft saved in another account', () => {
  const save = existingAccountId => call(OWNER, {
    method: 'POST', path: '/mail/draft', body: { ...draft, existingUid: 9, existingFolder: 'Drafts', existingAccountId },
  });

  it('deletes the old copy from another of the user\'s own accounts', async () => {
    expect((await save(SECOND_ACCOUNT_ID)).status).toBe(200);
    expect(imap.fns.permanentDeleteMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: SECOND_ACCOUNT_ID }), 9, 'Drafts', { expectMessageId: '<old@example.com>' });
  });

  it('leaves alone a copy in an account that is not the user\'s', async () => {
    ACCOUNTS[SECOND_ACCOUNT_ID].user_id = STRANGER;
    try {
      expect((await save(SECOND_ACCOUNT_ID)).status).toBe(200);
    } finally {
      ACCOUNTS[SECOND_ACCOUNT_ID].user_id = OWNER;
    }
    expect(imap.fns.permanentDeleteMessage).not.toHaveBeenCalled();
  });
});

// The lookup each route makes for the owner: which helper, with which arguments, exactly.
// Columns are compared with whitespace collapsed.
const CONTACT_VIEW = `c.id, c.uid, c.display_name, c.first_name, c.last_name, c.primary_email, c.emails, c.phones, c.organization,
  c.notes, c.photo_data, c.is_auto, c.send_count, c.last_sent, c.etag, c.vcard, c.created_at, c.updated_at,
  (ab.source = 'carddav') AS read_only`;
const LOOKUPS = {
  'PUT /accounts/:id': ['findOwnedAccount', ACCOUNT_ID, { columns: 'id, oauth_provider' }],
  'DELETE /accounts/:id': ['findOwnedAccount', ACCOUNT_ID, { columns: 'id' }],
  'POST /accounts/:id/reconnect': ['findOwnedAccount', ACCOUNT_ID],
  'GET /accounts/:id/aliases': ['findOwnedAccount', ACCOUNT_ID, { columns: 'id' }],
  'POST /accounts/:id/aliases': ['findOwnedAccount', ACCOUNT_ID, { columns: 'id' }],
  'PUT /accounts/:id/aliases/:aliasId': ['findOwnedAlias', ACCOUNT_ID, ALIAS_ID],
  'DELETE /accounts/:id/aliases/:aliasId': ['findOwnedAlias', ACCOUNT_ID, ALIAS_ID],
  'GET /accounts/:id/folders': ['findOwnedAccount', ACCOUNT_ID, { columns: 'id' }],
  'POST /accounts/:id/reindex': ['findOwnedAccount', ACCOUNT_ID, { enabled: true, protocol: 'imap' }],
  'POST /accounts/:id/spam/reset-training': ['findOwnedAccount', ACCOUNT_ID, { columns: 'id' }],
  'GET /spam/authserv-ids': ['findOwnedAccount', ACCOUNT_ID, { columns: 'id, trusted_authserv_id' }],
  'GET /spam/explain': ['findOwnedMessage', MESSAGE_ID, { columns: 'm.*, a.user_id AS owner_id, a.folder_mappings' }],
  'POST /rules/run': ['findOwnedAccount', ACCOUNT_ID, { columns: 'id' }],
  'POST /rules': ['findOwnedAccount', ACCOUNT_ID, { columns: 'id' }],
  'PUT /rules/:id': ['findOwnedAccount', ACCOUNT_ID, { columns: 'id' }],
  'POST /rules/sender-category': ['findOwnedMessage', MESSAGE_ID, { columns: 'm.from_email' }],
  'POST /mail/draft': ['findOwnedAccount', ACCOUNT_ID, { columns: 'id' }],
  'DELETE /mail/draft/:uid': ['findOwnedAccount', ACCOUNT_ID],
  'POST /categories/ai-classify/:messageId': ['findOwnedMessage', MESSAGE_ID, { columns: 'm.subject, m.from_email, m.snippet', live: true }],
  'GET /contacts/:id': ['findOwnedContact', CONTACT_ID, { columns: CONTACT_VIEW }],
  'PATCH /contacts/:id': ['findOwnedContact', CONTACT_ID, { columns: 'c.*, ab.source AS book_source' }],
  'DELETE /contacts/:id': ['findOwnedContact', CONTACT_ID, { columns: 'ab.source' }],
};
const normalize = arg => (arg?.columns ? { ...arg, columns: flat(arg.columns) } : arg);
const lookupsMade = () => ['findOwnedAccount', 'findOwnedMessage', 'findOwnedAlias', 'findOwnedContact']
  .flatMap(name => vi.mocked(ownership[name]).mock.calls.map(args => [name, ...args.map(normalize)]));

describe('each route looks up with its own columns and filters', () => {
  it('has a lookup pinned for every route', () => {
    expect(Object.keys(LOOKUPS).sort()).toEqual(cases.map(([name]) => name).sort());
  });

  it.each(cases)('%s', async (name, request) => {
    await call(OWNER, request);
    const [fn, ...args] = LOOKUPS[name];
    expect(lookupsMade()).toContainEqual([fn, OWNER, ...args.map(normalize)]);
  });

  it('looks up the account a replaced draft was saved in, in full', async () => {
    await call(OWNER, { method: 'POST', path: '/mail/draft', body: { ...draft, existingUid: 9, existingFolder: 'Drafts', existingAccountId: SECOND_ACCOUNT_ID } });
    expect(lookupsMade()).toContainEqual(['findOwnedAccount', OWNER, SECOND_ACCOUNT_ID]);
  });
});

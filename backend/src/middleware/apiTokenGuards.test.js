import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager: {} }));

import { query } from '../services/db.js';
import { apiTokenGuards, GUARD_NAMES } from './apiTokenGuards.js';
import { API_TOKEN_ROUTES, matchApiTokenRoute } from '../services/apiTokenAllowlist.js';

const USER = 'u1u1u1u1-0000-4000-8000-000000000001';
const GENERIC = '11111111-1111-4111-8111-111111111111';
const GMAIL = '22222222-2222-4222-8222-222222222222';
const ID1 = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const ID2 = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';

const MOVE_ERROR = 'API tokens cannot move mail into Trash, Junk, Drafts, Snoozed or folders MailFlow does not sync';
const DRAFT_SOURCE_ERROR = 'API tokens cannot move or archive drafts';
const PLAIN_TEXT_ERROR = 'API token drafts must be plain text';
const ALL_MAIL_ERROR = "API tokens cannot archive into Gmail's All Mail, where the mail drops out of MailFlow. "
  + "Create a Gmail label named Archive, or choose an archive folder in the account's settings.";

// The database: which accounts the ids are in (and whether one is a draft, or one of `drafts` is
// among them), each account's folders with the roles folderRoles reads, the folder each account's
// archive query finds, and the user's messages for the snooze guard to look up and gather.
let sources;
let folders;
let archives;
let messages;
let drafts;
function database() {
  query.mockImplementation(async (sql, params) => {
    if (sql.includes('bool_or(')) {
      return { rows: sources.map(s => ({ folder_mappings: null, ...s, has_draft: s.has_draft || params[1].some(id => drafts.has(id)) })) };
    }
    // resolveArchiveFolder, a mapping it checks, and isAllMailFolder, in mailUtils.js.
    if (sql.includes("special_use = '\\Archive'")) return { rows: archives[params[0]] ? [{ path: archives[params[0]] }] : [] };
    if (sql.includes('AND no_select = false')) {
      const folder = folders[params[0]]?.[params[1]];
      return { rows: folder && !folder.no_select ? [{}] : [] };
    }
    if (sql.includes("AND special_use = '\\All'")) return { rows: folders[params[0]]?.[params[1]]?.special_use === '\\All' ? [{}] : [] };
    if (sql.startsWith('SELECT m.* FROM messages m')) {
      const msg = messages.find(m => m.id === params[0]);
      return { rows: msg && params[1] === USER ? [msg] : [] };
    }
    if (sql.includes('AND thread_id = $2 AND message_id IS NOT NULL')) {
      return { rows: messages.filter(m => m.account_id === params[0] && m.thread_id === params[1] && m.message_id) };
    }
    if (sql.startsWith('SELECT sm.message_id_header FROM snoozed_messages sm')) return { rows: [] };
    if (sql.includes('FROM folders WHERE account_id = $1 AND path = $2')) {
      const folder = folders[params[0]]?.[params[1]];
      return { rows: folder ? [{ no_select: false, special_use: null, trash_rule: false, drafts_rule: false, spam_rule: false,
        mapped_trash: false, mapped_drafts: false, mapped_spam: false, snoozed_rule: false, snooze_record: false, ...folder }] : [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
}

beforeEach(() => {
  query.mockReset();
  sources = [{ id: GENERIC, imap_host: 'mail.example.com', oauth_provider: null, has_draft: false }];
  folders = { [GENERIC]: { Archive: {}, Receipts: {} } };
  archives = { [GENERIC]: 'Archive' };
  messages = [];
  drafts = new Set();
  database();
});

async function run(method, path, body) {
  const req = { originalUrl: path, body, session: { userId: USER }, apiToken: { route: matchApiTokenRoute(method, path) } };
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  const next = vi.fn();
  await apiTokenGuards(req, res, next);
  return {
    req,
    passed: next.mock.calls.length === 1 && next.mock.calls[0].length === 0,
    error: next.mock.calls[0]?.[0],
    status: res.status.mock.calls[0]?.[0],
    body: res.json.mock.calls[0]?.[0],
  };
}
const move = body => run('POST', '/api/mail/messages/bulk-move', body);
const archive = body => run('POST', '/api/mail/messages/bulk-archive', body);
const draft = body => run('POST', '/api/mail/draft', { accountId: GENERIC, to: ['a@example.com'], body: 'Hi', ...body });

describe('which requests are guarded', () => {
  it('every guard an allowlist entry names exists', () => {
    for (const route of API_TOKEN_ROUTES.filter(r => r.guard)) expect(GUARD_NAMES, route.path).toContain(route.guard);
  });

  it('a request without a guard, or no token at all, goes straight on', async () => {
    expect((await run('POST', '/api/mail/messages/bulk-read', { ids: [ID1], read: true })).passed).toBe(true);
    const next = vi.fn();
    await apiTokenGuards({ body: {} }, {}, next);
    expect(next).toHaveBeenCalledWith();
    expect(query).not.toHaveBeenCalled();
  });

  it('a guard that does not exist fails the request instead of letting it through', async () => {
    const next = vi.fn();
    await apiTokenGuards({ body: {}, apiToken: { route: { guard: 'bulkmove' } } }, {}, next);
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});

describe('bulk-move with a token', () => {
  it('moves into an ordinary folder', async () => {
    expect((await move({ ids: [ID1, ID2], folder: 'Archive' })).passed).toBe(true);
    // Only the user's own messages say which accounts are involved.
    expect(query.mock.calls[0][1]).toEqual([USER, [ID1, ID2]]);
  });

  it('leaves it to the route when the destination is missing from the account', async () => {
    expect((await move({ ids: [ID1], folder: 'Nowhere' })).passed).toBe(true);
  });

  it.each([
    ['a folder that cannot hold mail', 'Container', { no_select: true }],
    ['Trash by its flag', 'Bin', { special_use: '\\Trash' }],
    ['Junk by its flag', 'Unwanted', { special_use: '\\Junk' }],
    ['Drafts by its flag', 'Unsent', { special_use: '\\Drafts' }],
    ['All Mail by its flag', 'Everything', { special_use: '\\All' }],
    ['Starred by its flag', 'Stars', { special_use: '\\Flagged' }],
    ['Trash by its name', 'Deleted Messages', { trash_rule: true }],
    ['Drafts by its name', 'Drafts', { drafts_rule: true }],
    ['Spam by its name', 'Bulk Mail', { spam_rule: true }],
    ['the mapped Trash', 'Old', { mapped_trash: true }],
    ['the mapped Drafts', 'Wip', { mapped_drafts: true }],
    ['the mapped Spam', 'Filtered', { mapped_spam: true }],
    ['the Snoozed folder', 'Snoozed', {}],
    ['Snoozed under an INBOX. namespace prefix', 'INBOX.Snoozed', { snoozed_rule: true }],
    ['a folder a snooze record names', 'Later', { snooze_record: true }],
  ])('refuses %s', async (_label, path, roles) => {
    folders[GENERIC][path] = roles;
    expect(await move({ ids: [ID1], folder: path })).toMatchObject({ status: 403, body: { error: MOVE_ERROR } });
  });

  it.each(['[Gmail]/Important', '[Gmail]/Starred', '[Gmail]/All Mail'])('refuses Gmail\'s %s, which MailFlow does not sync', async (path) => {
    sources = [{ id: GMAIL, imap_host: 'imap.gmail.com', oauth_provider: null, has_draft: false }];
    folders[GMAIL] = { [path]: {} };
    expect(await move({ ids: [ID1], folder: path })).toMatchObject({ status: 403, body: { error: MOVE_ERROR } });
  });

  it('checks the destination in every account the messages are in', async () => {
    sources = [
      { id: GENERIC, imap_host: 'mail.example.com', oauth_provider: null, has_draft: false },
      { id: GMAIL, imap_host: 'imap.gmail.com', oauth_provider: null, has_draft: false },
    ];
    folders[GMAIL] = { Archive: { special_use: '\\Trash' } };
    expect(await move({ ids: [ID1, ID2], folder: 'Archive' })).toMatchObject({ status: 403 });
  });

  it('refuses to move a draft out of Drafts, wherever it goes', async () => {
    sources[0].has_draft = true;
    expect(await move({ ids: [ID1, ID2], folder: 'Archive' })).toMatchObject({ status: 403, body: { error: DRAFT_SOURCE_ERROR } });
  });

  it('leaves input the route refuses to the route, without touching the database', async () => {
    for (const body of [
      {}, { ids: ID1, folder: 'Archive' }, { ids: [], folder: 'Archive' }, { ids: ['not-a-uuid'], folder: 'Archive' },
      { ids: [ID1, 7], folder: 'Archive' }, { ids: Array(501).fill(ID1), folder: 'Archive' }, { ids: [ID1] },
      { ids: [ID1], folder: '' }, { ids: [ID1], folder: 7 }, { ids: [ID1], folder: 'a\nb' }, { ids: [ID1], folder: 'x'.repeat(256) },
    ]) {
      expect((await move(body)).passed, JSON.stringify(body).slice(0, 80)).toBe(true);
    }
    expect(query).not.toHaveBeenCalled();
  });
});

describe('bulk-archive with a token', () => {
  it('archives mail that is not a draft', async () => {
    expect((await archive({ ids: [ID1] })).passed).toBe(true);
  });

  it('refuses when any of the messages is a draft', async () => {
    sources = [
      { id: GENERIC, imap_host: 'mail.example.com', oauth_provider: null, has_draft: false },
      { id: GMAIL, imap_host: 'imap.gmail.com', oauth_provider: null, has_draft: true },
    ];
    expect(await archive({ ids: [ID1, ID2] })).toMatchObject({ status: 403, body: { error: DRAFT_SOURCE_ERROR } });
  });

  it('leaves input the route refuses to the route', async () => {
    for (const body of [{}, { ids: [] }, { ids: ['x'] }, { ids: Array(501).fill(ID1) }]) {
      expect((await archive(body)).passed).toBe(true);
    }
    expect(query).not.toHaveBeenCalled();
  });

  describe('on Gmail', () => {
    beforeEach(() => {
      sources = [{ id: GMAIL, imap_host: 'imap.gmail.com', oauth_provider: null, has_draft: false }];
      folders[GMAIL] = { '[Gmail]/All Mail': { special_use: '\\All' }, Archive: {} };
      archives[GMAIL] = '[Gmail]/All Mail';
    });

    it('refuses an archive into All Mail, which MailFlow does not sync', async () => {
      expect(await archive({ ids: [ID1] })).toMatchObject({ status: 403, body: { error: ALL_MAIL_ERROR } });
    });

    it('refuses it when the account maps its archive folder to All Mail', async () => {
      archives[GMAIL] = 'Archive';
      sources[0].folder_mappings = { archive: '[Gmail]/All Mail' };
      expect(await archive({ ids: [ID1] })).toMatchObject({ status: 403, body: { error: ALL_MAIL_ERROR } });
    });

    it('archives into a label named Archive, or the folder the account maps', async () => {
      archives[GMAIL] = 'Archive';
      expect((await archive({ ids: [ID1] })).passed).toBe(true);
      archives[GMAIL] = '[Gmail]/All Mail';
      sources[0].folder_mappings = { archive: 'Archive' };
      expect((await archive({ ids: [ID1] })).passed).toBe(true);
    });

    it('refuses when any account the messages are in would archive into All Mail', async () => {
      sources.unshift({ id: GENERIC, imap_host: 'mail.example.com', oauth_provider: null, has_draft: false });
      expect(await archive({ ids: [ID1, ID2] })).toMatchObject({ status: 403, body: { error: ALL_MAIL_ERROR } });
    });
  });

  it('leaves an account with no archive folder to the route, which reports it', async () => {
    archives = {};
    expect((await archive({ ids: [ID1] })).passed).toBe(true);
  });
});

describe('snoozing with a token', () => {
  const DRAFT = 'd4d4d4d4-4444-4444-8444-d4d4d4d4d4d4';
  const SENT = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';
  const message = (id, folder, messageId, inReplyTo = null) => ({
    id, account_id: GENERIC, folder, message_id: messageId, in_reply_to: inReplyTo, thread_references: null, thread_id: '<q@ext>',
  });
  const snooze = id => run('POST', `/api/mail/messages/${id}/snooze`, { until: '2026-10-20T08:00:00Z' });
  const checked = () => query.mock.calls.find(([sql]) => sql.includes('bool_or('))?.[1][1];

  // A question, its reply in the Inbox, my answer in Sent and a reply draft in Drafts.
  beforeEach(() => {
    messages = [
      message(ID1, 'INBOX', '<q@ext>'),
      message(ID2, 'INBOX', '<r@ext>', '<q@ext>'),
      message(SENT, 'Sent', '<s@me>', '<r@ext>'),
      message(DRAFT, 'Drafts', '<d@me>', '<r@ext>'),
    ];
  });

  it('snoozes mail that is not a draft, checking each message the route moves with it', async () => {
    expect((await snooze(ID1)).passed).toBe(true);
    // The reply chain in the Inbox, as the route gathers it; Sent and Drafts stay where they are.
    expect(checked()).toEqual([ID1, ID2]);
  });

  it('refuses to snooze a draft out of Drafts', async () => {
    drafts.add(DRAFT);
    expect(await snooze(DRAFT)).toMatchObject({ status: 403, body: { error: DRAFT_SOURCE_ERROR } });
  });

  it('refuses when a draft would go along with the message snoozed', async () => {
    // Flagged \Draft, in the Inbox with the rest of the chain.
    drafts.add(ID2);
    expect(await snooze(ID1)).toMatchObject({ status: 403, body: { error: DRAFT_SOURCE_ERROR } });
  });

  it('leaves a message the user does not have, or one without a Message-ID, to the route', async () => {
    expect((await snooze('e5e5e5e5-5555-4555-8555-e5e5e5e5e5e5')).passed).toBe(true);
    messages[0].message_id = null;
    expect((await snooze(ID1)).passed).toBe(true);
    expect(checked()).toBe(undefined);
  });
});

describe('drafts with a token', () => {
  it('saves a new plain-text draft, and makes it plain text for the route', async () => {
    for (const bodyIsHtml of [undefined, null, false]) {
      const result = await draft({ bodyIsHtml, subject: 'Re: lunch', quotedBody: '> earlier', inReplyTo: '<a@b>', references: '<a@b>',
        cc: [], bcc: ['me@example.com'], aliasId: GMAIL, editedSignature: '' });
      expect(result.passed, String(bodyIsHtml)).toBe(true);
      expect(result.req.body.bodyIsHtml).toBe(false);
    }
    expect((await draft({ aliasId: null, existingUid: null, existingFolder: null, existingAccountId: null })).passed).toBe(true);
  });

  it('never replaces an existing draft, which expunges the old copy', async () => {
    for (const field of ['existingUid', 'existingFolder', 'existingAccountId']) {
      for (const value of [12, '12', 'Drafts', GENERIC, '', 0, false]) {
        expect(await draft({ [field]: value }), `${field}=${value}`)
          .toMatchObject({ status: 403, body: { error: 'API tokens can only create new drafts' } });
      }
    }
  });

  // draft.js branches on truthiness, so a check for === true alone would let all but the first through.
  it.each([[true], [1], ['true'], ['false'], ['no'], [{}], [[]]])('refuses bodyIsHtml %j, which draft.js would take for HTML', async (bodyIsHtml) => {
    expect(await draft({ bodyIsHtml })).toMatchObject({ status: 400, body: { error: PLAIN_TEXT_ERROR } });
  });

  it('refuses HTML for the quote too', async () => {
    for (const quotedBodyHtml of ['<p>quote</p>', '', {}]) {
      expect(await draft({ quotedBodyHtml }), JSON.stringify(quotedBodyHtml)).toMatchObject({ status: 400, body: { error: PLAIN_TEXT_ERROR } });
    }
  });

  it('refuses ids that would reach a uuid comparison malformed', async () => {
    for (const accountId of [undefined, null, '', 'abc', 7, [GENERIC]]) {
      expect(await draft({ accountId }), String(accountId)).toMatchObject({ status: 400, body: { error: 'Invalid accountId' } });
    }
    expect(await draft({ aliasId: 'alias' })).toMatchObject({ status: 400, body: { error: 'Invalid aliasId' } });
  });

  it('refuses recipients that are not a list of strings, or that could break a header', async () => {
    for (const field of ['to', 'cc', 'bcc']) {
      for (const list of ['a@example.com', [7], [{}], ['a@example.com\r\nBcc: x@evil.example'], ['a\n@example.com'], ['a\u0000@example.com']]) {
        expect(await draft({ [field]: list }), `${field} ${JSON.stringify(list)}`).toMatchObject({ status: 400, body: { error: `Invalid ${field}` } });
      }
    }
  });

  it('takes the account\'s signature or none, never a signature of its own, which is HTML', async () => {
    for (const editedSignature of ['<img src="https://x.example/t.png">', ' ', null, 0]) {
      expect((await draft({ editedSignature })).status, JSON.stringify(editedSignature)).toBe(400);
    }
  });

  it('refuses text fields that are not text', async () => {
    for (const field of ['subject', 'body', 'quotedBody', 'inReplyTo', 'references']) {
      expect(await draft({ [field]: { toString: 'x' } }), field).toMatchObject({ status: 400, body: { error: `Invalid ${field}` } });
    }
  });

  it('needs no database', async () => {
    await draft({});
    expect(query).not.toHaveBeenCalled();
  });
});

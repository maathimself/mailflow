// Tests for the thread-level actions.
//
// The contract worth pinning is the one that is easy to get wrong when an action goes
// from one message to many: every message in the thread is removed and every one comes
// back, the request is held for the undo window rather than sent immediately, and spam
// deliberately spares the reader's own replies.
//
// Real store, real api layer, stubbed fetch and stubbed clock.

import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent,
});

let requests = [];
let failNext = false;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  requests.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null });
  if (failNext) return { ok: false, status: 500, json: async () => ({ error: 'server said no' }) };
  return { ok: true, status: 200, json: async () => ({}) };
};

const { useStore } = await import('../store/index.js');
const { resolveThreadMessages, archiveThread, deleteThread, spamThread, moveThread, snoozeThread } = await import('./threadActions.js');

// A thread of three: two from the correspondent, one the reader sent.
const THREAD = [
  { id: 'a1', account_id: 'acct', folder: 'INBOX', subject: 'Hello', from_email: 'them@x.z', date: '2026-01-01T00:00:00Z', is_read: true },
  { id: 'a2', account_id: 'acct', folder: 'Sent', subject: 'Re: Hello', from_email: 'me@x.z', date: '2026-01-02T00:00:00Z', is_read: true },
  { id: 'a3', account_id: 'acct', folder: 'INBOX', subject: 'Re: Hello', from_email: 'them@x.z', date: '2026-01-03T00:00:00Z', is_read: false },
];
const ACCOUNTS = [{ id: 'acct', email_address: 'me@x.z', aliases: [], folder_mappings: { sent: 'Sent' } }];

// The authoritative lookup the pane supplies. It returns a thread that has GAINED a
// message since the pane rendered, which is the staleness this module exists to handle.
const LATE_REPLY = { id: 'a4', account_id: 'acct', folder: 'INBOX', subject: 'Re: Hello', from_email: 'them@x.z', date: '2026-01-04T00:00:00Z', is_read: false };
const fetchThread = async () => ({ messages: [...THREAD, LATE_REPLY] });

const t = (key) => key;
let notifications = [];
const addNotification = n => notifications.push(n);

const ids = () => useStore.getState().messages.map(m => m.id).sort();
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const UNDO_WINDOW = 4500;

beforeEach(() => {
  requests = [];
  notifications = [];
  failNext = false;
  useStore.getState().setMessages(THREAD.map(m => ({ ...m })));
  useStore.setState({ accounts: ACCOUNTS });
});

describe('archiveThread', () => {
  test('removes the whole thread at once and holds the request for the undo window', async () => {
    archiveThread(THREAD, { t, addNotification });

    assert.deepEqual(ids(), [], 'every message in the thread disappears immediately');
    assert.equal(notifications.length, 1, 'one notification for the conversation, not one per message');

    // Well into the undo window, and still nothing sent. Asserting this only
    // synchronously would pass even if the request fired on the next tick.
    await tick(UNDO_WINDOW / 2);
    assert.deepEqual(requests, [], 'nothing is sent yet: the user still has time to undo');

    assert.equal(notifications[0].title, 'message.archived.conversationTitle', 'worded for a conversation');

    await tick(UNDO_WINDOW + 50);
    assert.equal(requests.length, 1, 'one bulk request for the whole thread');
    assert.match(requests[0].url, /bulk-archive/);
    assert.deepEqual(requests[0].body.ids.sort(), ['a1', 'a2', 'a3'], 'all three ids in a single call');
  });

  test('undo puts every message back and sends nothing', async () => {
    archiveThread(THREAD, { t, addNotification });
    assert.deepEqual(ids(), []);

    notifications[0].onUndo();
    assert.deepEqual(ids(), ['a1', 'a2', 'a3'], 'the whole conversation is restored, not just one message');

    await tick(UNDO_WINDOW + 50);
    assert.deepEqual(requests, [], 'an undone action never reaches the server');
  });

  test('a failed request restores the thread and reports it', async () => {
    failNext = true;
    archiveThread(THREAD, { t, addNotification });
    await tick(UNDO_WINDOW + 50);

    assert.deepEqual(ids(), ['a1', 'a2', 'a3'], 'a thread that failed to archive must come back');
    const failure = notifications.find(n => n.type === 'error');
    assert.ok(failure, 'the user is told the archive failed');
  });
});

// Archive from the conversation pane takes the conversation out of the folder it is shown in, as
// the list's archive does: the reader's reply stays in Sent.
describe('archiveThread scoped to the viewed folder', () => {
  test('archives the Inbox copies, the late reply included, and leaves the Sent reply', async () => {
    archiveThread(THREAD, { t, addNotification, fetchThread, anchorId: 'a3', folder: 'INBOX', accountId: 'acct' });
    assert.deepEqual(ids(), ['a2'], 'the Sent reply stays in the list behind the pane');
    await tick(UNDO_WINDOW + 50);
    assert.deepEqual(requests.at(-1).body.ids.sort(), ['a1', 'a3', 'a4']);
  });

  test('the unified inbox archives every account\'s Inbox copy; an account view only its own', async () => {
    const other = { id: 'b1', account_id: 'other', folder: 'INBOX', subject: 'Hello', from_email: 'them@x.z', date: '2026-01-01T00:00:00Z', is_read: true };
    const both = [...THREAD, other];
    useStore.getState().setMessages(both.map(m => ({ ...m })));
    archiveThread(both, { t, addNotification, anchorId: 'a3', folder: 'INBOX', accountId: null });
    await tick(UNDO_WINDOW + 50);
    assert.deepEqual(requests.at(-1).body.ids.sort(), ['a1', 'a3', 'b1']);

    requests = []; notifications = [];
    useStore.getState().setMessages(both.map(m => ({ ...m })));
    archiveThread(both, { t, addNotification, anchorId: 'a3', folder: 'INBOX', accountId: 'acct' });
    await tick(UNDO_WINDOW + 50);
    assert.deepEqual(requests.at(-1).body.ids.sort(), ['a1', 'a3']);
  });

  test('a conversation shown from another folder archives the copies there', async () => {
    const filed = THREAD.map(m => (m.folder === 'INBOX' ? { ...m, folder: 'Projects' } : m));
    archiveThread(filed, { t, addNotification, anchorId: 'a1', folder: 'Projects', accountId: 'acct' });
    await tick(UNDO_WINDOW + 50);
    assert.deepEqual(requests.at(-1).body.ids.sort(), ['a1', 'a3']);
  });

  test('with nothing left in the folder it archives the selected message, as the list does', async () => {
    archiveThread(THREAD, { t, addNotification, anchorId: 'a1', folder: 'Elsewhere', accountId: 'acct' });
    await tick(UNDO_WINDOW + 50);
    assert.deepEqual(requests.at(-1).body.ids, ['a1']);
  });
});

describe('deleteThread', () => {
  test('deletes every message in one call', async () => {
    deleteThread(THREAD, { t, addNotification });
    await tick(UNDO_WINDOW + 50);
    assert.match(requests[0].url, /bulk-delete/);
    assert.deepEqual(requests[0].body.ids.sort(), ['a1', 'a2', 'a3']);
  });
});

describe('a reply that arrives while the conversation is open', () => {
  test('is included in the action, not left behind', async () => {
    // The pane only knows the three messages it rendered. Acting on that snapshot would
    // archive three and leave the fourth in the inbox, resurrecting the thread.
    archiveThread(THREAD, { t, addNotification, fetchThread });
    await tick(UNDO_WINDOW + 50);

    assert.deepEqual(
      requests.at(-1).body.ids.sort(),
      ['a1', 'a2', 'a3', 'a4'],
      'the late reply is archived along with the rest of the thread',
    );
  });

  test('is still spared from a spam report when the reader sent it', async () => {
    spamThread(THREAD, { t, addNotification, accounts: ACCOUNTS, fetchThread });
    await tick(UNDO_WINDOW + 50);

    const spammed = requests.map(r => r.url.match(/messages\/([^/]+)\/spam/)?.[1]).filter(Boolean).sort();
    assert.deepEqual(spammed, ['a1', 'a3', 'a4'], 'the freshly resolved list is filtered too');
  });
});

describe('moveThread', () => {
  test('moves the whole conversation into the chosen folder', async () => {
    moveThread(THREAD, 'Archive/2026', { t, addNotification });
    assert.deepEqual(ids(), [], 'the conversation leaves the current folder at once');
    assert.equal(notifications[0].body, 'Archive/2026', 'the toast names where it went');

    await tick(UNDO_WINDOW + 50);
    const move = requests.find(r => /bulk-move/.test(r.url));
    assert.ok(move, 'a move request was sent');
    assert.deepEqual(move.body.ids.sort(), ['a1', 'a2', 'a3'], 'every message moves together');
    assert.equal(move.body.folder, 'Archive/2026');
  });

  test('undo brings the conversation back and moves nothing', async () => {
    moveThread(THREAD, 'Archive/2026', { t, addNotification });
    notifications[0].onUndo();
    assert.deepEqual(ids(), ['a1', 'a2', 'a3']);
    await tick(UNDO_WINDOW + 50);
    assert.equal(requests.filter(r => /bulk-move/.test(r.url)).length, 0);
  });
});

// A saved reply in the conversation (marked is_draft by the thread route). Deleting a draft
// expunges it, so deleting or moving the conversation must leave it alone.
describe('drafts in the conversation', () => {
  const DRAFT = { id: 'd1', account_id: 'acct', folder: 'Drafts', subject: 'Re: Hello', from_email: 'me@x.z', date: '2026-01-05T00:00:00Z', is_read: true, is_draft: true };
  const withDraft = [...THREAD.map(m => ({ ...m, is_draft: false })), DRAFT];
  const fetchWithDraft = async () => ({ messages: [...withDraft, { ...LATE_REPLY, is_draft: false }] });

  test('delete leaves the draft, in the list and on the server, the late reply included', async () => {
    useStore.getState().setMessages(withDraft.map(m => ({ ...m })));
    deleteThread(withDraft, { t, addNotification, fetchThread: fetchWithDraft, anchorId: 'a3' });
    assert.deepEqual(ids(), ['d1'], 'only the draft stays in the list');
    await tick(UNDO_WINDOW + 50);
    assert.deepEqual(requests.at(-1).body.ids.sort(), ['a1', 'a2', 'a3', 'a4']);
  });

  test('move leaves the draft too', async () => {
    moveThread(withDraft, 'Archive/2026', { t, addNotification, fetchThread: fetchWithDraft, anchorId: 'a1' });
    await tick(UNDO_WINDOW + 50);
    const move = requests.find(r => /bulk-move/.test(r.url));
    assert.deepEqual(move.body.ids.sort(), ['a1', 'a2', 'a3', 'a4']);
  });

  test('a conversation acted on from its draft (the Drafts folder) deletes only the draft', async () => {
    useStore.getState().setMessages(withDraft.map(m => ({ ...m })));
    deleteThread(withDraft, { t, addNotification, fetchThread: fetchWithDraft, anchorId: 'd1' });
    assert.deepEqual(ids(), ['a1', 'a2', 'a3'], 'the conversation it answers stays in the list');
    await tick(UNDO_WINDOW + 50);
    assert.deepEqual(requests.at(-1).body.ids, ['d1']);
  });

  test('archive leaves the draft in Drafts as well', async () => {
    archiveThread(withDraft, { t, addNotification, fetchThread: fetchWithDraft, anchorId: 'a1' });
    await tick(UNDO_WINDOW + 50);
    assert.deepEqual(requests.at(-1).body.ids.sort(), ['a1', 'a2', 'a3', 'a4']);
  });
});

describe('snoozeThread', () => {
  test('snoozes the newest inbox message, not the sent reply and not the whole thread', async () => {
    // a3 is the newest INBOX message. a2 is the reader's own sent reply, and snoozing it
    // would redeliver their own mail to them.
    const until = '2026-06-01T09:00:00.000Z';
    snoozeThread(THREAD, until, { t, addNotification });
    await tick(UNDO_WINDOW + 50);

    const snoozes = requests.filter(r => /\/snooze$/.test(r.url));
    assert.equal(snoozes.length, 1, 'exactly one message is snoozed');
    assert.match(snoozes[0].url, /messages\/a3\/snooze/, 'the newest inbox message');
    assert.equal(snoozes[0].body.until, until);
  });

  test('does nothing when the conversation has no inbox message left', async () => {
    const sentOnly = [THREAD[1]];
    snoozeThread(sentOnly, '2026-06-01T09:00:00.000Z', { t, addNotification });
    await tick(UNDO_WINDOW + 50);
    assert.deepEqual(notifications, [], 'no toast for an action that had no target');
    assert.equal(requests.filter(r => /snooze/.test(r.url)).length, 0);
  });
});

describe('spamThread', () => {
  test('spares the reader\'s own replies', async () => {
    spamThread(THREAD, { t, addNotification, accounts: ACCOUNTS });

    // a2 is the reader's own sent reply. Reporting it as spam would train the filter
    // on their own address, so it stays put.
    assert.deepEqual(ids(), ['a2'], 'the sent reply is left alone');

    await tick(UNDO_WINDOW + 50);
    const spammed = requests.map(r => r.url.match(/messages\/([^/]+)\/spam/)?.[1]).filter(Boolean).sort();
    assert.deepEqual(spammed, ['a1', 'a3'], 'only the correspondent\'s messages are reported');
  });
});

// One email delivered to two of the reader's accounts is two mailbox items. The conversation
// shows both (#476), but outside the unified inbox an action belongs to the row's account.
describe('a conversation another account also received', () => {
  // acct-b's copy of a3: the same email with the same Date, listed after a3 the way the
  // thread route breaks the tie (date, account_id, id), so it is also the newest inbox copy.
  // The thread route marks every message is_draft.
  const B3 = { ...THREAD[2], id: 'b3', account_id: 'acct-b' };
  const SPREAD = [...THREAD, B3].map(m => ({ ...m, is_draft: false }));
  const fetchSpread = async () => ({ messages: [...SPREAD, { ...LATE_REPLY, is_draft: false }] });
  // What the pane passes for acct's row: its account, and the selected message as the anchor
  // that keeps drafts and the rest of the conversation apart.
  const fromRow = { anchorId: 'a3', accountId: 'acct' };
  // A reply saved in each account (folder Drafts, so the thread route marks it is_draft).
  const AD = { id: 'ad', account_id: 'acct', folder: 'Drafts', subject: 'Re: Hello', from_email: 'me@x.z', date: '2026-01-05T00:00:00Z', is_read: true, is_draft: true };
  const WITH_DRAFTS = [...SPREAD, AD, { ...AD, id: 'bd', account_id: 'acct-b' }];
  const fetchWithDrafts = async () => ({ messages: WITH_DRAFTS });
  // Every request to the endpoint, so ids sent in a second request are not missed.
  const sentIds = pattern => requests.filter(r => pattern.test(r.url)).flatMap(r => r.body?.ids || []).sort();
  // These tests are about which copies an action takes, not when, so the undo window runs on a
  // mocked clock rather than the real 4.5 s in every test.
  const commit = async () => { mock.timers.tick(UNDO_WINDOW + 50); await new Promise(r => setImmediate(r)); };
  beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
  // What a test left on the clock (the delete guards' expiry, a recent-folder save) runs before
  // the reset: a module still holding a mocked timer would clear an unrelated one later. A minute
  // rather than runAll(), which ticks only to the last timer in its queue, not the latest.
  afterEach(() => { mock.timers.tick(60_000); mock.timers.reset(); });

  test('archive takes the row account\'s copies, the late reply included', async () => {
    archiveThread(SPREAD, { t, addNotification, fetchThread: fetchSpread, ...fromRow });
    await commit();
    assert.deepEqual(sentIds(/bulk-archive/), ['a1', 'a2', 'a3', 'a4']);
  });

  test('archive with nothing of the account\'s in the folder takes none of the other account\'s copies', async () => {
    // A label folder's copy is deduplicated away in favour of the INBOX copy, so the thread holds
    // neither the selected message nor anything in that folder. Archive falls back to the newest
    // message, and the newest on screen is acct-b's copy. The fallback now keeps to acct's copies;
    // that it still lands outside the folder is a folder question, not pinned here.
    const onScreen = async () => ({ messages: SPREAD });
    archiveThread(SPREAD, { t, addNotification, fetchThread: onScreen, anchorId: 'label-copy', folder: 'Work', accountId: 'acct' });
    await commit();
    const archived = sentIds(/bulk-archive/);
    assert.ok(archived.length > 0, 'something is archived');
    assert.ok(!archived.includes('b3'), 'and none of it is acct-b\'s');
  });

  test('delete never sends the other account\'s copy', async () => {
    deleteThread(SPREAD, { t, addNotification, fetchThread: fetchSpread, ...fromRow });
    await commit();
    assert.deepEqual(sentIds(/bulk-delete/), ['a1', 'a2', 'a3', 'a4']);
  });

  test('move sends one account\'s copies and records the folder for that account only', async () => {
    useStore.setState({ recentFolders: [] });
    moveThread(SPREAD, 'Projects', { t, addNotification, fetchThread: fetchSpread, ...fromRow });
    await commit();
    assert.deepEqual(sentIds(/bulk-move/), ['a1', 'a2', 'a3', 'a4']);
    assert.deepEqual(useStore.getState().recentFolders, [{ accountId: 'acct', path: 'Projects' }]);
  });

  test('spam reports only the row account\'s copies', async () => {
    spamThread(SPREAD, { t, addNotification, accounts: ACCOUNTS, fetchThread: fetchSpread, ...fromRow });
    await commit();
    const spammed = requests.map(r => r.url.match(/messages\/([^/]+)\/spam/)?.[1]).filter(Boolean).sort();
    assert.deepEqual(spammed, ['a1', 'a3', 'a4']);
  });

  test('snooze takes the row account\'s newest inbox copy, not the other account\'s', async () => {
    snoozeThread(SPREAD, '2026-06-01T09:00:00.000Z', { t, addNotification, ...fromRow });
    await commit();
    const snoozes = requests.filter(r => /\/snooze$/.test(r.url));
    assert.equal(snoozes.length, 1);
    assert.match(snoozes[0].url, /messages\/a3\/snooze/);
  });

  // Drafts are told apart before the account is. The anchor can be the other account's copy
  // picked under the row, and only among every copy does it say whether the drafts are acted on.
  test('the other account\'s copy picked under the row takes the row account\'s mail and spares its draft', async () => {
    deleteThread(WITH_DRAFTS, { t, addNotification, fetchThread: fetchWithDrafts, anchorId: 'b3', accountId: 'acct' });
    moveThread(WITH_DRAFTS, 'Projects', { t, addNotification, fetchThread: fetchWithDrafts, anchorId: 'b3', accountId: 'acct' });
    await commit();
    assert.deepEqual(sentIds(/bulk-delete/), ['a1', 'a2', 'a3']);
    assert.deepEqual(sentIds(/bulk-move/), ['a1', 'a2', 'a3']);
  });

  test('the other account\'s draft picked under the row: Delete takes that draft alone, Archive and Move nothing', async () => {
    // Acting on a draft takes the conversation's drafts, never the rest of it (keepDraftsApart), and
    // a deleted draft is expunged. A draft is not a copy of anything acct holds, so acct-b's stands
    // for none of acct's mail: taking acct's drafts in its place would act on them and leave the
    // draft picked, and narrowing to acct first would take acct's whole conversation. Delete is the
    // reader discarding the draft they opened, so it takes that one, and none of acct-b's others.
    const thread = [...WITH_DRAFTS, { ...AD, id: 'bd2', account_id: 'acct-b', date: '2026-01-06T00:00:00Z' }];
    useStore.getState().setMessages(thread.map(m => ({ ...m })));
    const opts = { t, addNotification, fetchThread: async () => ({ messages: thread }), accountId: 'acct', anchorId: 'bd' };
    assert.equal(archiveThread(thread, { ...opts, folder: 'INBOX' }), false, 'archive takes nothing');
    assert.equal(moveThread(thread, 'Projects', opts), false, 'move takes nothing');
    assert.deepEqual(notifications, [], 'and neither shows a toast');
    assert.equal(deleteThread(thread, opts), true, 'delete takes the draft');
    assert.deepEqual(ids(), ['a1', 'a2', 'a3', 'ad', 'b3', 'bd2'], 'which alone leaves the list');
    await commit();
    assert.equal(requests.length, 1, 'one request in all');
    assert.deepEqual(sentIds(/bulk-delete/), ['bd'], 'and alone is deleted');
  });

  test('the other account\'s draft gone by the commit has nothing taken in its place', async () => {
    // Sent, discarded or saved again under a new id during the undo window. A re-read no longer holds
    // it, and drafts told apart without it would take acct's conversation instead.
    const gone = WITH_DRAFTS.filter(m => m.id !== 'bd');
    deleteThread(WITH_DRAFTS, { t, addNotification, fetchThread: async () => ({ messages: gone }), anchorId: 'bd', accountId: 'acct' });
    await commit();
    assert.deepEqual(sentIds(/bulk-delete/), ['bd'], 'only the draft\'s own id is sent');
  });

  test('the row account\'s own draft picked under the row takes the row account\'s drafts', async () => {
    // Only the other account's draft is set apart. acct's own is one of acct's drafts, and acting on
    // it takes them all (keepDraftsApart), each action alike.
    const thread = [...WITH_DRAFTS, { ...AD, id: 'ad2', date: '2026-01-06T00:00:00Z' }];
    const opts = { t, addNotification, fetchThread: async () => ({ messages: thread }), anchorId: 'ad', accountId: 'acct' };
    assert.equal(archiveThread(thread, opts), true, 'archive takes them');
    assert.equal(moveThread(thread, 'Projects', opts), true, 'move takes them');
    assert.equal(deleteThread(thread, opts), true, 'delete takes them');
    await commit();
    assert.deepEqual(sentIds(/bulk-archive/), ['ad', 'ad2']);
    assert.deepEqual(sentIds(/bulk-move/), ['ad', 'ad2']);
    assert.deepEqual(sentIds(/bulk-delete/), ['ad', 'ad2'], 'not acct-b\'s');
  });

  test('in the unified inbox a draft picked takes the conversation\'s drafts, whichever account\'s', async () => {
    // There is no row account there to set acct-b's draft apart from.
    const opts = { t, addNotification, fetchThread: fetchWithDrafts, anchorId: 'bd', accountId: null };
    assert.equal(archiveThread(WITH_DRAFTS, opts), true, 'archive takes them');
    assert.equal(moveThread(WITH_DRAFTS, 'Projects', opts), true, 'move takes them');
    assert.equal(deleteThread(WITH_DRAFTS, opts), true, 'delete takes them');
    await commit();
    assert.deepEqual(sentIds(/bulk-archive/), ['ad', 'bd']);
    assert.deepEqual(sentIds(/bulk-move/), ['ad', 'bd']);
    assert.deepEqual(sentIds(/bulk-delete/), ['ad', 'bd']);
  });

  test('the other account\'s message picked under the row leaves the row account\'s drafts alone, even when they are all it holds', async () => {
    // Drafts are told apart among every account's copies, where the picked message is found. Told
    // apart among acct's alone, which hold only its draft here, the pick would not be found, and
    // keepDraftsApart keeps everything rather than act on nothing: acct's draft would be expunged.
    const thread = [SPREAD.find(m => m.id === 'b3'), AD];
    assert.equal(deleteThread(thread, { t, addNotification, fetchThread: async () => ({ messages: thread }), anchorId: 'b3', accountId: 'acct' }), false);
    await commit();
    assert.deepEqual(requests, [], 'nothing is sent');
  });

  test('undo puts back only the row account\'s copies', () => {
    // The optimistic removal and its undo use the messages on screen, so those are scoped too:
    // otherwise undoing put the other account's copy into this account's list.
    for (const run of [archiveThread, deleteThread, spamThread]) run(SPREAD, { t, addNotification, accounts: ACCOUNTS, ...fromRow });
    moveThread(SPREAD, 'Projects', { t, addNotification, ...fromRow });
    notifications.forEach(n => n.onUndo());
    assert.deepEqual(ids(), ['a1', 'a2', 'a3']);
  });

  test('each runner says whether it took anything, which decides whether the pane moves on', () => {
    // The account can have copies here and still none an action takes: Snooze takes only an
    // inbox copy, and Spam spares the reader's own mail.
    const until = '2026-06-01T09:00:00.000Z';
    const filed = SPREAD.map(m => (m.account_id === 'acct' ? { ...m, folder: 'Archive' } : m));
    const own = SPREAD.map(m => (m.account_id === 'acct' ? { ...m, folder: 'Sent' } : m));
    assert.equal(snoozeThread(filed, until, { t, addNotification, ...fromRow }), false);
    assert.equal(spamThread(own, { t, addNotification, accounts: ACCOUNTS, ...fromRow }), false);
    assert.deepEqual(notifications, [], 'neither shows a toast');
    const opts = { t, addNotification, accounts: ACCOUNTS, ...fromRow };
    assert.equal(snoozeThread(SPREAD, until, opts), true);
    for (const run of [archiveThread, deleteThread, spamThread]) assert.equal(run(SPREAD, opts), true, run.name);
    assert.equal(moveThread(SPREAD, 'Projects', opts), true);
    notifications.forEach(n => n.onUndo());
  });

  test('beforeRemove runs once an action has something to take, while its messages are still listed', () => {
    // The pane opens what takes the conversation's place from there (#572): it looks the row up
    // before the row leaves the list, and must not move on when the action takes nothing.
    const until = '2026-06-01T09:00:00.000Z';
    const runs = {
      archiveThread: opts => archiveThread(SPREAD, opts),
      deleteThread: opts => deleteThread(SPREAD, opts),
      moveThread: opts => moveThread(SPREAD, 'Projects', opts),
      spamThread: opts => spamThread(SPREAD, opts),
      snoozeThread: opts => snoozeThread(SPREAD, until, opts),
    };
    for (const [name, run] of Object.entries(runs)) {
      useStore.getState().setMessages(THREAD.map(m => ({ ...m })));
      const listed = [];
      run({ t, addNotification, accounts: ACCOUNTS, ...fromRow, beforeRemove: () => listed.push(ids()) });
      assert.deepEqual(listed, [['a1', 'a2', 'a3']], `${name} calls it once, before anything leaves the list`);
    }
    const listed = [];
    const opts = { t, addNotification, accounts: ACCOUNTS, ...fromRow, beforeRemove: () => listed.push(ids()) };
    snoozeThread(SPREAD.map(m => ({ ...m, folder: 'Archive' })), until, opts);
    spamThread(SPREAD.map(m => ({ ...m, folder: 'Sent' })), opts);
    deleteThread(SPREAD, { ...opts, accountId: 'acct-c' });
    assert.deepEqual(listed, [], 'and never when it takes nothing');
    notifications.forEach(n => n.onUndo());
  });

  test('with no account, as in the unified inbox, every account\'s copies still go', async () => {
    deleteThread(SPREAD, { t, addNotification, fetchThread: fetchSpread, anchorId: 'a3' });
    await commit();
    assert.deepEqual(sentIds(/bulk-delete/), ['a1', 'a2', 'a3', 'a4', 'b3']);
  });
});

// ---------------------------------------------------------------------------
// Resolving which messages an action operates on. These suites predate the action
// runners above and guard the staleness bug documented in threadActions.js.

const row = { id: 'row', thread_id: 't1' };
const cached = [{ id: 'a', is_read: false }, { id: 'b', is_read: false }];
const fresh = [...cached, { id: 'c', is_read: false }];   // 'c' arrived after the cache was built
const fetchFresh = () => Promise.resolve({ messages: fresh });

describe('the unread that could not be cleared', () => {
  test('acts on the server truth, not the snapshot taken when the thread was opened', async () => {
    // The bug: a reply arrived after the thread was expanded, so marking the thread read sent
    // only the cached ids. The newer message stayed unread on the server while the UI rendered
    // the row as read, hiding it. The badge then showed an unread nobody could reach.
    const got = await resolveThreadMessages({ message: row, isThreadRow: true, cached, fetchThread: fetchFresh });
    assert.deepEqual(got.map(m => m.id), ['a', 'b', 'c']);
  });

  test('a stale cache is ignored by default, so no caller inherits the bug', async () => {
    let fetched = false;
    await resolveThreadMessages({
      message: row, isThreadRow: true, cached,
      fetchThread: () => { fetched = true; return Promise.resolve({ messages: fresh }); },
    });
    assert.equal(fetched, true, 'the default must reach the server');
  });

  test('destructive actions cannot silently leave the newest messages behind', async () => {
    // A thread-wide delete or move built from a stale list drops whatever arrived since.
    const got = await resolveThreadMessages({ message: row, isThreadRow: true, cached, fetchThread: fetchFresh });
    assert.ok(got.some(m => m.id === 'c'), 'the message that arrived after expansion must be included');
  });
});

describe('resolveThreadMessages: the other paths', () => {
  test('an ordinary row is its own action and never hits the network', async () => {
    let fetched = false;
    const got = await resolveThreadMessages({
      message: row, isThreadRow: false, cached,
      fetchThread: () => { fetched = true; return Promise.resolve({ messages: fresh }); },
    });
    assert.deepEqual(got, [row]);
    assert.equal(fetched, false);
  });

  test('allowCache is honoured when a caller explicitly opts in', async () => {
    let fetched = false;
    const got = await resolveThreadMessages({
      message: row, isThreadRow: true, cached, allowCache: true,
      fetchThread: () => { fetched = true; return Promise.resolve({ messages: fresh }); },
    });
    assert.deepEqual(got.map(m => m.id), ['a', 'b']);
    assert.equal(fetched, false);
  });

  test('an empty or missing cache still fetches even when caching is allowed', async () => {
    for (const c of [undefined, null, [], 'nope']) {
      const got = await resolveThreadMessages({
        message: row, isThreadRow: true, cached: c, allowCache: true, fetchThread: fetchFresh,
      });
      assert.equal(got.length, 3, `cached=${String(c)} must fall through to the server`);
    }
  });
});

describe('resolveThreadMessages: degenerate responses', () => {
  test('an empty thread response falls back to the row rather than acting on nothing', async () => {
    // Reducing a thread action to zero messages would look like a silent no-op to the user.
    for (const bad of [{ messages: [] }, {}, null, undefined]) {
      const got = await resolveThreadMessages({
        message: row, isThreadRow: true, cached, fetchThread: () => Promise.resolve(bad),
      });
      assert.deepEqual(got, [row], `response=${JSON.stringify(bad)} must fall back to the row`);
    }
  });

  test('a rejected fetch propagates, so callers can roll their optimistic update back', async () => {
    await assert.rejects(
      resolveThreadMessages({
        message: row, isThreadRow: true, cached,
        fetchThread: () => Promise.reject(new Error('offline')),
      }),
      /offline/,
    );
  });
});

describe('resolveThreadMessages: one account', () => {
  const mine = [{ id: 'a', account_id: 'acct' }, { id: 'c', account_id: 'acct' }];
  const theirs = { id: 'b', account_id: 'acct-b' };
  const fetchMixed = () => Promise.resolve({ messages: [mine[0], theirs, mine[1]] });

  test('keeps the given account\'s copies and drops another account\'s', async () => {
    const got = await resolveThreadMessages({ message: row, isThreadRow: true, fetchThread: fetchMixed, accountId: 'acct' });
    assert.deepEqual(got.map(m => m.id), ['a', 'c']);
  });

  test('falls back to the row when the thread holds none of that account\'s copies', async () => {
    const got = await resolveThreadMessages({
      message: row, isThreadRow: true, accountId: 'acct',
      fetchThread: () => Promise.resolve({ messages: [theirs] }),
    });
    assert.deepEqual(got, [row]);
  });

  test('with no account every copy comes back, which the unified inbox relies on', async () => {
    const got = await resolveThreadMessages({ message: row, isThreadRow: true, fetchThread: fetchMixed });
    assert.deepEqual(got.map(m => m.id), ['a', 'b', 'c']);
  });
});

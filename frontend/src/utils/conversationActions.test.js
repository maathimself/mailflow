import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';

// keepDraftsApart reads the account's folders from the store, which loads the locales.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    return nextLoad(url, context);
  },
});
const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent });

const { useStore } = await import('../store/index.js');
const {
  conversationActionIds,
  conversationSpamTargets,
  groupConversationMessagesByAccount,
  newestSnoozeTarget,
  keepDraftsApart,
} = await import('./conversationActions.js');

const message = (id, overrides = {}) => ({
  id,
  message_id: `<${id}@example.test>`,
  account_id: 'account-a',
  folder: 'INBOX',
  from_email: 'sender@example.test',
  date: '2026-07-26T10:00:00Z',
  ...overrides,
});

describe('conversation action targets', () => {
  it('returns one database ID for each distinct RFC message', () => {
    const messages = [
      message('inbox-copy', { message_id: '<same@example.test>' }),
      message('archive-copy', { message_id: '<same@example.test>', folder: 'Archive' }),
      message('other'),
    ];

    assert.deepEqual(conversationActionIds(messages), ['inbox-copy', 'other']);
  });

  it('groups normalized messages by account', () => {
    const grouped = groupConversationMessagesByAccount([
      message('a-1'),
      message('b-1', { account_id: 'account-b' }),
      message('a-2'),
    ]);

    assert.deepEqual(Object.fromEntries(
      Object.entries(grouped).map(([accountId, messages]) => [accountId, messages.map(item => item.id)])
    ), {
      'account-a': ['a-1', 'a-2'],
      'account-b': ['b-1'],
    });
  });

  it('excludes sent-folder and own-address messages from spam targets', () => {
    const accounts = [{
      id: 'account-a',
      email_address: 'me@example.test',
      aliases: [{ email: 'alias@example.test' }],
      folder_mappings: { sent: 'Sent Items' },
    }];
    const messages = [
      message('received'),
      message('sent-folder', { folder: 'Sent Items', from_email: 'other@example.test' }),
      message('sent-primary', { folder: 'Archive', from_email: 'ME@example.test' }),
      message('sent-alias', { folder: 'Archive', from_email: 'alias@example.test' }),
    ];

    assert.deepEqual(conversationSpamTargets(messages, accounts).map(item => item.id), ['received']);
  });

  it('selects the newest inbox message as the snooze target', () => {
    const messages = [
      message('older', { date: '2026-07-26T08:00:00Z' }),
      message('sent-newest', { folder: 'Sent', date: '2026-07-26T12:00:00Z' }),
      message('newer', { date: '2026-07-26T11:00:00Z' }),
    ];

    assert.equal(newestSnoozeTarget(messages)?.id, 'newer');
    assert.equal(newestSnoozeTarget([message('sent-only', { folder: 'Sent' })]), null);
  });
});

describe('keepDraftsApart', () => {
  const thread = [
    message('received'),
    message('reply', { folder: 'Sent', is_draft: false }),
    message('draft', { folder: 'Drafts', is_draft: true }),
    message('draft2', { folder: 'Drafts', is_draft: true }),
  ];

  it('leaves drafts out of a conversation acted on from an ordinary message', () => {
    assert.deepEqual(keepDraftsApart(thread, 'received').map(m => m.id), ['received', 'reply']);
    assert.deepEqual(keepDraftsApart(thread, undefined).map(m => m.id), ['received', 'reply']);
  });

  it('touches only the drafts when the message acted on is a draft, as in the Drafts folder', () => {
    assert.deepEqual(keepDraftsApart(thread, 'draft').map(m => m.id), ['draft', 'draft2']);
  });

  it('keeps a thread with nothing on the other side, so the action is not silently empty', () => {
    const drafts = [message('d1', { is_draft: true }), message('d2', { is_draft: true })];
    assert.deepEqual(keepDraftsApart(drafts, 'other').map(m => m.id), ['d1', 'd2']);
    const plain = [message('p1'), message('p2')];
    assert.deepEqual(keepDraftsApart(plain, 'p1').map(m => m.id), ['p1', 'p2']);
  });

  it('passes through messages with no draft marker and tolerates a missing list', () => {
    assert.deepEqual(keepDraftsApart([message('x')], 'x').map(m => m.id), ['x']);
    assert.deepEqual(keepDraftsApart(undefined, 'x'), []);
  });
});

// A conversation comes back from every folder. Deleting it from the Inbox took its copies already in
// Trash, where a delete expunges for good, and moving it pulled them back out.
describe('keepDraftsApart leaves Trash and Spam alone', () => {
  const thread = [
    message('old', { folder: '[Gmail]/Trash' }),
    message('junk', { folder: 'Spam-folder' }),
    message('new'),
    message('mine', { folder: 'Sent' }),
  ];
  const withFolders = (fn) => {
    const { folders, accounts } = useStore.getState();
    useStore.setState({
      folders: { 'account-a': [{ path: '[Gmail]/Trash', special_use: '\\Trash' }, { path: 'Spam-folder' }] },
      accounts: [{ id: 'account-a', folder_mappings: { spam: 'Spam-folder' } }],
    });
    try { fn(); } finally { useStore.setState({ folders, accounts }); }
  };

  it('acting from another folder leaves the Trash and Spam copies where they are', () => withFolders(() => {
    assert.deepEqual(keepDraftsApart(thread, 'new').map(m => m.id), ['new', 'mine']);
  }));

  it('acting from Trash or Spam still takes the whole conversation', () => withFolders(() => {
    assert.deepEqual(keepDraftsApart(thread, 'old').map(m => m.id), ['old', 'junk', 'new', 'mine']);
  }));

  it('knows Trash by name when the folder list has not loaded', () => {
    const list = [message('old', { account_id: 'b', folder: 'Deleted Items' }), message('new', { account_id: 'b' })];
    assert.deepEqual(keepDraftsApart(list, 'new').map(m => m.id), ['new']);
  });
});

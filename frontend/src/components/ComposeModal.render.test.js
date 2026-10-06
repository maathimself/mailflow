// Render test for ComposeModal's draft autosave (#413).
//
// The autosave rules are unit-tested in utils/draftAutosave.test.js, but whether a draft counts
// as dirty depends on the live TipTap editor, which rewrites the HTML it loads. That only shows
// up with the real component mounted, so this mounts it the same way the other render tests do.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k) => k, i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export const Trans = ({ children }) => children ?? null;',
        'export const I18nextProvider = ({ children }) => children ?? null;',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    const shimViteEnv = (code) => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    if (url.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

let visibility = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const ComposeModal = (await import('./ComposeModal.jsx')).default;

// A draft as Gmail saves it. TipTap loads this as <p> paragraphs, so its getHTML() never
// matches the stored string even when nobody has touched it.
const GMAIL_DRAFT = '<div dir="ltr">Hi Bob,<div><br></div><div>The contract is attached.</div></div>';

const saved = [];

// Autosave also runs when the tab is hidden, without waiting for the idle timer, which makes
// it the deterministic way to ask the composer "would you save now?".
async function hideTab() {
  visibility = 'hidden';
  await React.act(async () => { document.dispatchEvent(new window.Event('visibilitychange')); });
  await React.act(async () => {});
  visibility = 'visible';
}

// Opens a draft the way MessageList does for a click in the Drafts folder. Returns an unmount.
async function openDraft({ plaintextEmail, body }) {
  saved.length = 0;
  useStore.setState({ plaintextEmail, composing: false, composeData: null, prepareComposeSwitch: null });
  useStore.getState().openCompose({
    accountId: 'acct',
    draftUid: 7,
    draftFolder: 'Drafts',
    to: ['Bob <bob@example.invalid>'],
    cc: [],
    subject: 'Contract',
    body,
    bodyIsHtml: !plaintextEmail,
  });
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(ComposeModal)); });
  // immediatelyRender: false creates the editor in an effect after the first commit.
  await React.act(async () => {});
  return () => React.act(async () => root.unmount());
}

before(() => {
  api.saveDraft = async (payload) => { saved.push(payload); return { uid: 8, folder: 'Drafts' }; };
  useStore.setState({
    user: { id: 'u1' },
    accounts: [{ id: 'acct', enabled: true, email_address: 'me@example.invalid', name: 'Me', color: '#fff' }],
  });
});

describe('reopening a draft saved by another client', () => {
  let close;
  before(async () => { close = await openDraft({ plaintextEmail: false, body: GMAIL_DRAFT }); });
  after(() => close());

  test('mounts the draft into the editor', () => {
    const editor = document.querySelector('.ProseMirror')?.editor;
    assert.ok(editor, 'the rich-text editor mounted');
    assert.match(editor.getHTML(), /The contract is attached\./);
    assert.notEqual(editor.getHTML(), GMAIL_DRAFT, 'precondition: TipTap rewrote the stored HTML');
  });

  test('does not autosave a draft that was only opened', async () => {
    await hideTab();
    assert.equal(saved.length, 0, 'an untouched draft must not be rewritten');
  });

  test('still autosaves once the body is edited, replacing the same draft', async () => {
    saved.length = 0;
    const editor = document.querySelector('.ProseMirror').editor;
    await React.act(async () => { editor.commands.insertContent(' Thanks.'); });
    await hideTab();
    assert.equal(saved.length, 1, 'a real edit is saved');
    assert.equal(saved[0].existingUid, 7);
    assert.equal(saved[0].existingFolder, 'Drafts');
    assert.match(saved[0].body, /Thanks\./);
  });
});

describe('reopening a draft in plain-text mode', () => {
  // The editor still mounts in plain-text mode, but the dirty check compares the textarea, so
  // its baseline has to stay the raw body.
  let close;
  before(async () => { close = await openDraft({ plaintextEmail: true, body: 'Hi Bob,\n\nThe contract is attached.' }); });
  after(() => close());

  test('does not autosave a draft that was only opened', async () => {
    await hideTab();
    assert.equal(saved.length, 0, 'an untouched draft must not be rewritten');
  });
});

describe('switching From on a reopened draft', () => {
  // The old copy stays in the account it was saved to. The backend used to delete its uid in
  // whichever account From named, which expunged an unrelated message there when both
  // accounts have a Drafts folder.
  let close;
  before(async () => {
    useStore.setState({
      accounts: [
        { id: 'acct', enabled: true, email_address: 'me@example.invalid', name: 'Me', color: '#fff' },
        { id: 'other', enabled: true, email_address: 'other@example.invalid', name: 'Other', color: '#000' },
      ],
    });
    close = await openDraft({ plaintextEmail: false, body: GMAIL_DRAFT });
  });
  after(() => close());

  test('names the account that holds the copy being replaced', async () => {
    const from = [...document.querySelectorAll('select')]
      .find(s => [...s.options].some(o => o.value === 'account:other'));
    await React.act(async () => {
      from.value = 'account:other';
      from.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    const editor = document.querySelector('.ProseMirror').editor;
    await React.act(async () => { editor.commands.insertContent(' Thanks.'); });
    await hideTab();
    assert.equal(saved.length, 1, 'the edit is saved');
    assert.equal(saved[0].accountId, 'other', 'the new copy goes to the account From names');
    assert.equal(saved[0].existingUid, 7);
    assert.equal(saved[0].existingFolder, 'Drafts');
    assert.equal(saved[0].existingAccountId, 'acct', 'the old copy is deleted from its own account');
  });

  test('the next save replaces the new copy in the account it was saved to', async () => {
    saved.length = 0;
    const editor = document.querySelector('.ProseMirror').editor;
    await React.act(async () => { editor.commands.insertContent(' Bye.'); });
    await hideTab();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].existingUid, 8);
    assert.equal(saved[0].existingAccountId, 'other');
  });
});

describe('automatic Cc and Bcc (#491)', () => {
  // Several tests assert that nothing happens (no chip, no save). Each first shows the automatic
  // address appearing where it should, so none of them can pass with the feature missing.
  const ME = 'me@example.invalid';
  const SENDER = { name: 'Sender', email: 'sender@example.invalid' };
  const posted = [];
  let realPost;

  const account = (id, { cc = [], bcc = [], aliases } = {}) => ({
    id, enabled: true, email_address: `${id}@example.invalid`, name: id, color: '#fff',
    auto_cc_addresses: cc, auto_bcc_addresses: bcc, ...(aliases ? { aliases } : {}),
  });
  // What composeFromMessage hands over for Reply All, and for Reply.
  const replyAll = (thread) => ({
    accountId: 'A', isReply: true, isReplyAll: true, subject: 'Re: Plan', body: '',
    to: [SENDER], originalFrom: [SENDER], cc: thread, allRecipients: thread,
  });
  const reply = (thread) => ({ ...replyAll(thread), isReplyAll: false, cc: [] });
  // A thread that already Cc's the address account A sends an automatic Bcc to.
  const PERSONAL = 'me@personal.example.invalid';
  const THREAD = [{ name: '', email: 'thread@example.invalid' }, { name: '', email: PERSONAL }];
  const BOTH_LISTS = { cc: ['boss@example.invalid'], bcc: [PERSONAL] };

  // Opens the composer through the store, as every entry point does. Returns an unmount.
  async function mountCompose(composeData, { accounts, strict = false }) {
    saved.length = 0;
    posted.length = 0;
    useStore.setState({ plaintextEmail: false, accounts, selectedAccountId: accounts[0]?.id ?? null, defaultSender: '', composing: false, composeData: null, prepareComposeSwitch: null });
    useStore.getState().openCompose(composeData);
    const root = createRoot(document.getElementById('root'));
    const modal = React.createElement(ComposeModal);
    await React.act(async () => { root.render(strict ? React.createElement(React.StrictMode, null, modal) : modal); });
    await React.act(async () => {});
    return () => React.act(async () => root.unmount());
  }

  const rowOf = (label) => [...document.querySelectorAll('span')].find(s => s.textContent === label)?.parentElement ?? null;
  // The chips in the row labelled `label`, or null when that row is not rendered at all.
  const chips = (label) => {
    const row = rowOf(label);
    return row ? [...row.querySelectorAll('span[title]')].map(s => s.title) : null;
  };
  const click = (el) => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });

  async function chooseFrom(value) {
    const from = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === value));
    await React.act(async () => {
      from.value = value;
      from.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
  }
  async function typeInto(input, text) {
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    await React.act(async () => {
      setValue.call(input, text);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  }
  const typeSubject = (text) => typeInto(document.querySelector('input[placeholder="compose.subject"]'), text);
  // Types a recipient into the row labelled `label` and commits it with Enter.
  async function addChip(label, text) {
    const input = rowOf(label).querySelector('input');
    await typeInto(input, text);
    await React.act(async () => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
  }
  async function send() {
    await click([...document.querySelectorAll('button')].find(b => b.textContent === 'compose.send'));
    await React.act(async () => {});
    return posted.find(p => p.path === '/mail/send')?.body;
  }
  // Renders at phone width, where the composer has its own layout with Reply and Reply All tabs.
  async function onMobile(run) {
    const width = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 375 });
    try {
      await run((label) => [...document.querySelectorAll('button')].find(b => b.textContent === label));
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
    }
  }
  async function editBody(text) {
    const editor = document.querySelector('.ProseMirror').editor;
    await React.act(async () => { editor.commands.insertContent(text); });
  }
  async function removeChip(label, address) {
    const chip = [...rowOf(label).querySelectorAll('span[title]')].find(s => s.title === address);
    await click(chip.querySelector('button'));
  }
  async function switchReplyType(label) {
    await click([...document.querySelectorAll('button')].find(b => /^compose\.reply(All)?$/.test(b.textContent)));
    await click([...document.querySelectorAll('div')].find(d => d.textContent === label));
  }

  before(() => {
    // A reply autofocuses the editor, and TipTap focuses through requestAnimationFrame.
    globalThis.requestAnimationFrame ??= cb => setTimeout(() => cb(Date.now()), 0);
    realPost = api.post;
    api.post = async (path, body) => { posted.push({ path, body }); return { sentFolder: 'Sent' }; };
  });
  after(() => { api.post = realPost; });

  test('a new message shows the account\'s automatic Bcc in a visible Bcc row', async () => {
    const close = await mountCompose({}, { accounts: [account('A', { bcc: [ME] })] });
    try {
      assert.deepEqual(chips('compose.bcc'), [ME]);
    } finally { await close(); }
  });

  test('an untouched composer with automatic recipients is not autosaved and closes without a prompt', async () => {
    const close = await mountCompose({}, { accounts: [account('A', { cc: ['boss@example.invalid'], bcc: [ME] })] });
    try {
      assert.deepEqual(chips('compose.cc'), ['boss@example.invalid']);
      assert.deepEqual(chips('compose.bcc'), [ME]);
      await hideTab();
      assert.equal(saved.length, 0, 'nothing the user did needs saving');
      const unload = new window.Event('beforeunload', { cancelable: true });
      window.dispatchEvent(unload);
      assert.equal(unload.defaultPrevented, false, 'no leave-page prompt');
      await click(document.querySelector('button[title="compose.toolbar.close"]'));
      assert.equal(useStore.getState().composing, false, 'closed straight away, without the save-or-discard dialog');
    } finally { await close(); }
  });

  test('the automatic Bcc is saved and sent like any other recipient', async () => {
    const close = await mountCompose({ to: ['x@example.invalid'] }, { accounts: [account('A', { bcc: [ME] })] });
    try {
      await typeSubject('Plan');
      await hideTab();
      assert.equal(saved.length, 1);
      assert.deepEqual(saved[0].bcc, [ME]);
      const sent = await send();
      assert.ok(sent, 'the message was sent');
      assert.deepEqual(sent.bcc, [ME]);
      assert.deepEqual(sent.to, ['x@example.invalid']);
    } finally { await close(); }
  });

  test('a message forwarded as an attachment is sent by id, its own attachments by part (#466)', async () => {
    const close = await mountCompose({
      to: ['submit.x@spam.spamcop.net'], subject: 'Fwd: You won', isForward: true,
      forwardedAttachments: [
        { messageId: 'spam-1', asMessage: true, filename: 'You won.eml', type: 'message/rfc822', size: null },
        { messageId: 'other-1', part: '2', filename: 'invoice.pdf', type: 'application/pdf', size: 2048 },
      ],
    }, { accounts: [account('A')] });
    try {
      const chipText = [...document.querySelectorAll('span')].map(sp => sp.textContent).join(' | ');
      assert.ok(chipText.includes('You won.eml'));
      assert.ok(!/NaN|undefined|nullB/.test(chipText), 'a message attachment shows no made-up size');
      const sent = await send();
      assert.ok(sent, 'the message was sent');
      assert.deepEqual(sent.forwardedMessages, ['spam-1']);
      assert.deepEqual(sent.forwardedAttachments, [{ messageId: 'other-1', part: '2' }]);
    } finally { await close(); }
  });

  test('a mailto Bcc is kept alongside the automatic Bcc, and the composer stays clean', async () => {
    const close = await mountCompose(
      { to: ['x@example.invalid'], bcc: ['u@example.invalid'] },
      { accounts: [account('A', { bcc: [ME] })] },
    );
    try {
      assert.deepEqual(chips('compose.bcc'), ['u@example.invalid', ME]);
      await hideTab();
      assert.equal(saved.length, 0);
    } finally { await close(); }
  });

  test('reply-all keeps an automatic Cc that is not on the thread', async () => {
    const close = await mountCompose(
      replyAll([{ name: '', email: 'thread@example.invalid' }]),
      { accounts: [account('A', { cc: ['boss@example.invalid'] })] },
    );
    try {
      assert.deepEqual(chips('compose.cc'), ['thread@example.invalid', 'boss@example.invalid']);
    } finally { await close(); }
  });

  test('reply-all lists an automatic Cc that is already on the thread only once', async () => {
    const close = await mountCompose(
      replyAll([{ name: '', email: 'ARCHIVE@example.invalid' }]),
      { accounts: [account('A', { cc: ['archive@example.invalid', 'boss@example.invalid'] })] },
    );
    try {
      assert.deepEqual(chips('compose.cc'), ['ARCHIVE@example.invalid', 'boss@example.invalid']);
    } finally { await close(); }
  });

  test('a reopened draft is not given the automatic recipients, on opening or on a From switch', async () => {
    const accounts = [account('acct', { bcc: [ME] }), account('other', { bcc: ['other-auto@example.invalid'] })];
    const fresh = await mountCompose({}, { accounts });
    try {
      assert.deepEqual(chips('compose.bcc'), [ME], 'a new message from the same account gets it');
    } finally { await fresh(); }

    const close = await openDraft({ plaintextEmail: false, body: GMAIL_DRAFT });
    try {
      assert.equal(chips('compose.bcc'), null, 'no Bcc row: the draft saved none');
      await hideTab();
      assert.equal(saved.length, 0, 'opening the draft is still not an edit');
      await chooseFrom('account:other');
      assert.equal(chips('compose.bcc'), null, 'nor from the account From switches to');
      await hideTab();
      assert.equal(saved.length, 1, 'a saved sender change is persisted');
    } finally { await close(); }
  });

  test('a message reopened by undo send keeps the Cc and Bcc it was sent with', async () => {
    const accounts = [account('acct', { bcc: [ME] })];
    const fresh = await mountCompose({}, { accounts });
    try {
      assert.deepEqual(chips('compose.bcc'), [ME], 'a new message from the account gets it');
    } finally { await fresh(); }

    // Sent without the automatic Bcc (the user removed it), then undone. No draft was saved.
    const close = await mountCompose({ accountId: 'acct', to: ['x@example.invalid'], cc: [], bcc: [], subject: 'Plan', body: '<p>Plan</p>', restored: true }, { accounts });
    try {
      assert.equal(chips('compose.bcc'), null, 'the removed automatic Bcc does not come back');
    } finally { await close(); }
  });

  test('switching From before any save swaps only the automatic addresses', async () => {
    const accounts = [account('A', { bcc: ['a@example.invalid'] }), account('B', { bcc: ['b@example.invalid'] })];
    const close = await mountCompose({ to: ['x@example.invalid'], bcc: ['u@example.invalid'] }, { accounts });
    try {
      assert.deepEqual(chips('compose.bcc'), ['u@example.invalid', 'a@example.invalid']);
      await chooseFrom('account:B');
      assert.deepEqual(chips('compose.bcc'), ['u@example.invalid', 'b@example.invalid']);
      await typeSubject('Plan');
      await hideTab();
      assert.equal(saved.length, 1);
      assert.equal(saved[0].accountId, 'B');
      assert.deepEqual(saved[0].bcc, ['u@example.invalid', 'b@example.invalid']);
    } finally { await close(); }
  });

  test('switching From on an untouched composer is not an edit', async () => {
    const accounts = [account('A', { bcc: ['a@example.invalid'] }), account('B', { bcc: ['b@example.invalid'] })];
    const close = await mountCompose({}, { accounts });
    try {
      await chooseFrom('account:B');
      assert.deepEqual(chips('compose.bcc'), ['b@example.invalid']);
      await hideTab();
      assert.equal(saved.length, 0);
    } finally { await close(); }
  });

  test('switching From to another account and back gives the first account\'s automatic Bcc back', async () => {
    const accounts = [account('A', { bcc: ['a@example.invalid'] }), account('B', { bcc: ['b@example.invalid'] })];
    const close = await mountCompose({ to: ['x@example.invalid'] }, { accounts });
    try {
      await chooseFrom('account:B');
      assert.deepEqual(chips('compose.bcc'), ['b@example.invalid']);
      await chooseFrom('account:A');
      assert.deepEqual(chips('compose.bcc'), ['a@example.invalid']);
    } finally { await close(); }
  });

  test('a Cc or Bcc the user typed before a From switch is still an unsaved edit', async () => {
    const accounts = [
      account('A', { cc: ['a-cc@example.invalid'], bcc: ['a@example.invalid'] }),
      account('B', { cc: ['b-cc@example.invalid'], bcc: ['b@example.invalid'] }),
    ];
    for (const [field, fromB] of [['cc', 'b-cc@example.invalid'], ['bcc', 'b@example.invalid']]) {
      const close = await mountCompose({ to: ['x@example.invalid'] }, { accounts });
      try {
        await addChip(`compose.${field}`, 'typed@example.invalid');
        await chooseFrom('account:B');
        await hideTab();
        assert.equal(saved.length, 1, `the typed ${field} is the only edit, and it is saved`);
        assert.deepEqual(saved[0][field], ['typed@example.invalid', fromB]);
      } finally { await close(); }
    }
  });

  test('a tab hidden right after a From switch does not save the old account\'s chips under the new From', async () => {
    const accounts = [account('A', { bcc: ['a@example.invalid'] }), account('B', { bcc: ['b@example.invalid'] })];
    const close = await mountCompose({}, { accounts });
    const actEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
    try {
      // Outside act(), so React schedules as it does in a browser: the From change renders in a
      // microtask, and the tab is hidden straight after it, before any later task can run.
      globalThis.IS_REACT_ACT_ENVIRONMENT = false;
      const from = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'account:B'));
      from.value = 'account:B';
      from.dispatchEvent(new window.Event('change', { bubbles: true }));
      await Promise.resolve();
      visibility = 'hidden';
      document.dispatchEvent(new window.Event('visibilitychange'));
      visibility = 'visible';
      await new Promise(resolve => setTimeout(resolve, 0));
      globalThis.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
      await React.act(async () => {});
      assert.deepEqual(chips('compose.bcc'), ['b@example.invalid']);
      assert.deepEqual(saved.map(s => ({ accountId: s.accountId, bcc: s.bcc })), [], 'an untouched composer is not saved');
    } finally {
      globalThis.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
      await close();
    }
  });

  test('switching From after an autosave saves the new From together with its lists', async () => {
    const accounts = [account('A', { bcc: ['a@example.invalid'] }), account('B', { bcc: ['b@example.invalid'] })];
    const close = await mountCompose({ to: ['x@example.invalid'] }, { accounts });
    try {
      await editBody('Hi');
      await hideTab();
      assert.equal(saved.length, 1);
      assert.equal(saved[0].accountId, 'A');
      assert.deepEqual(saved[0].bcc, ['a@example.invalid']);

      await chooseFrom('account:B');
      await hideTab();
      assert.equal(saved.length, 2, 'the switch alone is saved');
      assert.equal(saved[1].accountId, 'B');
      assert.deepEqual(saved[1].bcc, ['b@example.invalid']);
      assert.equal(saved[1].existingUid, 8);
      assert.equal(saved[1].existingAccountId, 'A');
    } finally { await close(); }
  });

  test('an automatic address the user removed is not added back by a From switch', async () => {
    const accounts = [account('A', { cc: ['crm@example.invalid'] }), account('B', { cc: ['crm@example.invalid'] })];
    const close = await mountCompose({}, { accounts });
    try {
      assert.deepEqual(chips('compose.cc'), ['crm@example.invalid']);
      await removeChip('compose.cc', 'crm@example.invalid');
      await chooseFrom('account:B');
      assert.deepEqual(chips('compose.cc'), []);
      await chooseFrom('account:A');
      assert.deepEqual(chips('compose.cc'), [], 'nor by switching back');
    } finally { await close(); }
  });

  test('a From switch keeps a recipient the user added for an automatic address', async () => {
    const accounts = [account('A', { cc: ['boss@example.invalid'] }), account('B')];
    const close = await mountCompose({ to: ['x@example.invalid'], subject: 'Plan' }, { accounts });
    try {
      await addChip('compose.cc', 'Boss Person <boss@example.invalid>');
      assert.deepEqual(chips('compose.cc'), ['boss@example.invalid', 'Boss Person <boss@example.invalid>']);
      await chooseFrom('account:B');
      assert.deepEqual(chips('compose.cc'), ['Boss Person <boss@example.invalid>'], 'only the automatic chip goes');
      const sent = await send();
      assert.equal(sent.accountId, 'B');
      assert.deepEqual(sent.cc, ['Boss Person <boss@example.invalid>']);
    } finally { await close(); }
  });

  test('Reply All to Reply keeps the automatic Bcc, and its row stays while the user edits it', async () => {
    const close = await mountCompose(
      replyAll([{ name: '', email: 'thread@example.invalid' }]),
      { accounts: [account('A', { bcc: [ME] })] },
    );
    try {
      assert.deepEqual(chips('compose.bcc'), [ME]);
      await switchReplyType('compose.reply');
      assert.equal(chips('compose.cc'), null, 'the thread\'s Cc goes, as before');
      assert.deepEqual(chips('compose.bcc'), [ME]);
      await hideTab();
      assert.deepEqual(saved.at(-1).bcc, [ME]);

      const input = rowOf('compose.bcc').querySelector('input');
      await React.act(async () => {
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
      });
      assert.deepEqual(chips('compose.bcc'), [], 'Backspace removes the chip but leaves the row');
    } finally { await close(); }
  });

  test('Reply to Reply All keeps the automatic Cc and leaves no address in both Cc and Bcc', async () => {
    const close = await mountCompose(reply(THREAD), { accounts: [account('A', BOTH_LISTS)] });
    try {
      assert.deepEqual(chips('compose.cc'), ['boss@example.invalid']);
      assert.deepEqual(chips('compose.bcc'), [PERSONAL]);
      await switchReplyType('compose.replyAll');
      assert.deepEqual(chips('compose.cc'), ['thread@example.invalid', PERSONAL, 'boss@example.invalid']);
      assert.deepEqual(chips('compose.bcc') ?? [], [], 'the thread has it in Cc, so it is not in Bcc as well');
    } finally { await close(); }
  });

  test('the mobile Reply and Reply All tabs keep the automatic Bcc as well', () => onMobile(async (tab) => {
    const close = await mountCompose(
      replyAll([{ name: '', email: 'thread@example.invalid' }]),
      { accounts: [account('A', { bcc: [ME] })] },
    );
    try {
      assert.ok(tab('compose.reply'), 'the mobile layout is rendered');
      assert.deepEqual(chips('compose.bcc'), [ME]);
      await click(tab('compose.reply'));
      assert.deepEqual(chips('compose.bcc'), [ME]);
      await click(tab('compose.replyAll'));
      assert.deepEqual(chips('compose.cc'), ['thread@example.invalid']);
      assert.deepEqual(chips('compose.bcc'), [ME]);
    } finally { await close(); }
  }));

  test('the mobile Reply All tab keeps the automatic Cc and leaves no address in both Cc and Bcc', () => onMobile(async (tab) => {
    const close = await mountCompose(reply(THREAD), { accounts: [account('A', BOTH_LISTS)] });
    try {
      assert.ok(tab('compose.replyAll'), 'the mobile layout is rendered');
      assert.deepEqual(chips('compose.cc'), ['boss@example.invalid']);
      assert.deepEqual(chips('compose.bcc'), [PERSONAL]);
      await click(tab('compose.replyAll'));
      assert.deepEqual(chips('compose.cc'), ['thread@example.invalid', PERSONAL, 'boss@example.invalid']);
      assert.deepEqual(chips('compose.bcc') ?? [], [], 'the thread has it in Cc, so it is not in Bcc as well');
    } finally { await close(); }
  }));

  test('Reply All to Reply keeps an automatic Cc that was on the thread', async () => {
    const close = await mountCompose(
      replyAll([{ name: '', email: 'archive@example.invalid' }]),
      { accounts: [account('A', { cc: ['archive@example.invalid'] })] },
    );
    try {
      assert.deepEqual(chips('compose.cc'), ['archive@example.invalid']);
      await switchReplyType('compose.reply');
      assert.deepEqual(chips('compose.cc'), ['archive@example.invalid']);
    } finally { await close(); }
  });

  test('a From switch after Reply All to Reply takes out the automatic Bcc that Reply placed', async () => {
    const close = await mountCompose(replyAll(THREAD), { accounts: [account('A', { bcc: [PERSONAL] }), account('B')] });
    try {
      assert.equal(chips('compose.bcc'), null, 'Reply All: the thread already has it in Cc');
      await switchReplyType('compose.reply');
      assert.deepEqual(chips('compose.bcc'), [PERSONAL]);
      await chooseFrom('account:B');
      assert.deepEqual(chips('compose.bcc'), [], 'B has no lists');
    } finally { await close(); }
  });

  test('an alias reply opened before accounts load gets the automatic Bcc when they arrive, and stays clean', async () => {
    const close = await mountCompose({
      accountId: 'late', aliasId: 'al1', isReply: true, subject: 'Re: Plan', body: '',
      to: [SENDER], originalFrom: [SENDER], cc: [], allRecipients: [],
    }, { accounts: [] });
    try {
      assert.equal(chips('compose.bcc'), null);
      await React.act(async () => {
        useStore.setState({ accounts: [account('late', { bcc: [ME], aliases: [{ id: 'al1', email: 'alias@example.invalid', name: 'Alias' }] })] });
      });
      assert.deepEqual(chips('compose.bcc'), [ME]);
      await hideTab();
      assert.equal(saved.length, 0);
    } finally { await close(); }
  });

  test('under StrictMode the automatic Bcc is applied once and the composer stays clean', async () => {
    const close = await mountCompose(
      { to: ['x@example.invalid'], bcc: ['u@example.invalid'] },
      { accounts: [account('A', { bcc: [ME] })], strict: true },
    );
    try {
      assert.deepEqual(chips('compose.bcc'), ['u@example.invalid', ME]);
      await hideTab();
      assert.equal(saved.length, 0);
    } finally { await close(); }
  });
});

describe('undo send', () => {
  // Mounted the way MailApp mounts it, so closing the composer unmounts it and reopening it
  // mounts a fresh one from the store's composeData.
  const Host = () => (useStore(s => s.composing) ? React.createElement(ComposeModal) : null);
  const posted = [];
  const deleted = [];
  const cancels = [];
  let unmount;
  before(async () => {
    useStore.setState({
      plaintextEmail: false, composing: false, composeData: null, prepareComposeSwitch: null,
      notifications: [],
      accounts: [{ id: 'acct', enabled: true, email_address: 'me@example.invalid', name: 'Me', color: '#fff' }],
    });
    api.post = async (path, payload) => {
      posted.push({ path, payload });
      return { ok: true, pending: true, pendingId: 'p1', sendAt: new Date(Date.now() + 10_000).toISOString(), remainingMs: 9_500 };
    };
    api.deleteDraft = async (...args) => { deleted.push(args); return { ok: true }; };
    api.cancelSend = async (id) => { cancels.push(id); return { cancelled: true }; };
    api.getSendStatus = async () => ({ status: 'pending' });
    useStore.getState().openCompose({
      accountId: 'acct',
      draftUid: 7,
      draftFolder: 'Drafts',
      to: ['Bob <bob@example.invalid>'],
      cc: [],
      subject: 'Contract',
      body: '<p>Here it is.</p>',
      attachments: [{ name: 'contract.pdf', size: 3, type: 'application/pdf', data: 'QUJD' }],
      priority: 'high',
    });
    const root = createRoot(document.getElementById('root'));
    await React.act(async () => { root.render(React.createElement(Host)); });
    await React.act(async () => {});
    unmount = () => React.act(async () => root.unmount());
  });
  after(() => unmount());

  test('Send hands the message to the server with an undo window and closes the composer', async () => {
    const send = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'compose.send');
    await React.act(async () => { send.click(); });
    await React.act(async () => {});
    assert.equal(posted.length, 1);
    const { payload } = posted[0];
    assert.equal(payload.undoSeconds, 10);
    assert.deepEqual(payload.draft, { uid: 7, folder: 'Drafts', accountId: 'acct' });
    assert.equal(payload.attachments[0].filename, 'contract.pdf');
    assert.equal(payload.priority, 'high');
    assert.equal(useStore.getState().composing, false);
    assert.deepEqual(deleted, [], 'the draft stays until the server has delivered the message');
    const bar = useStore.getState().notifications.find(n => n.onUndo);
    assert.equal(bar.title, 'compose.undoSend.sending', 'the bar names the message (its subject)');
    assert.equal(bar.undoMs, 9_500, 'Undo lasts what the server said was left');
  });

  test('Undo gives the message back as it was sent, attachments included', async () => {
    const bar = useStore.getState().notifications.find(n => n.onUndo);
    await React.act(async () => { await bar.onUndo(); });
    await React.act(async () => {});
    assert.deepEqual(cancels, ['p1']);
    assert.equal(useStore.getState().composing, true);
    const data = useStore.getState().composeData;
    assert.equal(data.subject, 'Contract');
    assert.deepEqual(data.to, ['Bob <bob@example.invalid>']);
    assert.equal(data.priority, 'high');
    assert.equal(data.draftUid, 7);
    assert.match(document.body.textContent, /contract\.pdf/, 'the attachment is back in the composer');
    assert.match(document.querySelector('.ProseMirror').editor.getHTML(), /Here it is\./);
  });

  test('the reopened message counts as unsaved, so its draft is brought up to date', async () => {
    saved.length = 0;
    await hideTab();
    assert.equal(saved.length, 1, 'saved although nothing was typed since it reopened');
    assert.equal(saved[0].existingUid, 7);
    assert.equal(saved[0].subject, 'Contract');
  });

  test('a server without undo send delivers at once, and the draft is deleted from here', async () => {
    posted.length = 0;
    api.post = async (path, payload) => { posted.push({ path, payload }); return { ok: true }; };
    const send = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'compose.send');
    await React.act(async () => { send.click(); });
    await React.act(async () => {});
    assert.equal(useStore.getState().composing, false);
    assert.deepEqual(deleted, [['acct', 8, 'Drafts']], 'the copy saved after the undo');
    assert.equal(useStore.getState().notifications[0].title, 'compose.sent.title');
  });
});

describe('undo send, message without attachments', () => {
  // With nothing to set it apart from its draft, only being a reopened message keeps it from
  // looking saved: closing it would then drop whatever was typed after the last autosave.
  const Host = () => (useStore(s => s.composing) ? React.createElement(ComposeModal) : null);
  let unmount;
  before(async () => {
    useStore.setState({ plaintextEmail: false, notifications: [] });
    api.post = async () => ({ ok: true, pending: true, pendingId: 'p2', sendAt: new Date(Date.now() + 10_000).toISOString() });
    api.cancelSend = async () => ({ cancelled: true });
    useStore.getState().openCompose({
      accountId: 'acct', draftUid: 9, draftFolder: 'Drafts',
      to: ['Bob <bob@example.invalid>'], cc: [], subject: 'Plan', body: '<p>Typed after the last autosave.</p>',
    });
    const root = createRoot(document.getElementById('root'));
    await React.act(async () => { root.render(React.createElement(Host)); });
    await React.act(async () => {});
    unmount = () => React.act(async () => root.unmount());
  });
  after(() => unmount());

  test('the reopened message still counts as unsaved', async () => {
    const send = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'compose.send');
    await React.act(async () => { send.click(); });
    await React.act(async () => {});
    const bar = useStore.getState().notifications.find(n => n.onUndo);
    await React.act(async () => { await bar.onUndo(); });
    await React.act(async () => {});
    saved.length = 0;
    await hideTab();
    assert.equal(saved.length, 1, 'saved although nothing was typed since it reopened');
    assert.equal(saved[0].existingUid, 9);
    assert.match(saved[0].body, /Typed after the last autosave\./);
  });
});

describe('undo send while another message is being written', () => {
  // Keyed the way MailApp keys it.
  const Host = () => {
    const composing = useStore(s => s.composing);
    const session = useStore(s => s.composeSession);
    return composing ? React.createElement(ComposeModal, { key: session }) : null;
  };
  let unmount;
  let next = 0;
  before(async () => {
    useStore.setState({ plaintextEmail: false, notifications: [], composing: false, composeData: null });
    api.post = async () => ({ ok: true, pending: true, pendingId: `p-${++next}`, sendAt: new Date(Date.now() + 10_000).toISOString(), remainingMs: 10_000 });
    api.cancelSend = async () => ({ cancelled: true });
    const root = createRoot(document.getElementById('root'));
    await React.act(async () => { root.render(React.createElement(Host)); });
    unmount = () => React.act(async () => root.unmount());
  });
  after(async () => {
    // Signing out stops following the held sends, as it must for the next user of the tab.
    await React.act(async () => { useStore.setState({ user: { id: 'someone-else' } }); });
    assert.equal(useStore.getState().notifications.some(n => n.heldSendId), false, 'no Undo bar is left behind');
    await unmount();
  });

  const subjectField = () => document.querySelector('input[placeholder="compose.subject"]');
  const sendButton = () => [...document.querySelectorAll('button')].find(b => /compose\.(send|sending)$/.test(b.textContent.trim()));
  async function write(subject) {
    await React.act(async () => {
      useStore.getState().openCompose({ accountId: 'acct', to: ['Bob <bob@example.invalid>'], cc: [], subject, body: `<p>${subject} body</p>` });
    });
    await React.act(async () => {});
  }
  async function send() {
    await React.act(async () => { sendButton().click(); });
    await React.act(async () => {});
  }

  test('the undone message opens as itself once the open one is sent', async () => {
    await write('Plan A');
    await send();
    const undoA = useStore.getState().notifications.find(n => n.onUndo);
    await write('Plan B');
    await React.act(async () => { await undoA.onUndo(); });
    assert.equal(subjectField().value, 'Plan B', 'the message being written is left alone');

    await send();
    assert.equal(useStore.getState().composeData.subject, 'Plan A');
    assert.equal(subjectField().value, 'Plan A', 'the screen shows the reopened message, not the one just sent');
    assert.equal(sendButton().textContent.trim(), 'compose.send', 'and it can be sent again');
    assert.equal(sendButton().disabled, false);
  });
});

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
        // Keys stand in for text. The one string that wraps another (the AI panel's error) shows
        // what it wraps, so a test can tell which error it is.
        'export const useTranslation = () => ({ t: (k, o) => (o?.message ? `${k} ${o.message}` : k), i18n: { language: "en", changeLanguage: () => {} } });',
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

  // Writes a message in a composer keyed the way MailApp keys it, sends it with an undo window and
  // undoes it, so the undone message mounts a composer of its own. `beforeSend` runs first;
  // `whileSending` runs after Send is clicked and before the server has answered. Returns an
  // unmount.
  async function sendAndUndo(composeData, { accounts, beforeSend, whileSending }) {
    const Host = () => {
      const composing = useStore(s => s.composing);
      const session = useStore(s => s.composeSession);
      return composing ? React.createElement(ComposeModal, { key: session }) : null;
    };
    const plainPost = api.post;
    let answer;
    api.post = (path, body) => {
      posted.push({ path, body });
      if (path !== '/mail/send') return plainPost(path, body);
      return new Promise(resolve => {
        answer = () => resolve({ ok: true, pending: true, pendingId: 'p-auto', sendAt: new Date(Date.now() + 10_000).toISOString(), remainingMs: 10_000 });
      });
    };
    api.cancelSend = async () => ({ cancelled: true });
    saved.length = 0;
    posted.length = 0;
    useStore.setState({ plaintextEmail: false, accounts, selectedAccountId: accounts[0].id, defaultSender: '', notifications: [], composing: false, composeData: null });
    useStore.getState().openCompose(composeData);
    const root = createRoot(document.getElementById('root'));
    await React.act(async () => { root.render(React.createElement(Host)); });
    await React.act(async () => {});
    const unmount = () => React.act(async () => root.unmount());
    try {
      await beforeSend?.();
      await send();
      await whileSending?.();
      await React.act(async () => { answer(); });
      await React.act(async () => {});
      const bar = useStore.getState().notifications.find(n => n.onUndo);
      await React.act(async () => { await bar.onUndo(); });
      await React.act(async () => {});
    } catch (err) {
      await unmount();
      throw err;
    } finally {
      api.post = plainPost;
    }
    return unmount;
  }

  test('after undo send, an automatic address removed before sending stays out across From switches', async () => {
    const accounts = [account('A', { cc: ['crm@example.invalid'] }), account('B', { cc: ['crm@example.invalid'] })];
    const cc = () => chips('compose.cc') ?? [];
    const close = await sendAndUndo({ to: ['x@example.invalid'], subject: 'Plan' }, {
      accounts,
      beforeSend: async () => {
        assert.deepEqual(cc(), ['crm@example.invalid']);
        await removeChip('compose.cc', 'crm@example.invalid');
      },
    });
    try {
      assert.deepEqual(cc(), [], 'reopened as it was sent');
      await chooseFrom('account:B');
      assert.deepEqual(cc(), [], 'a From switch does not bring it back');
      await chooseFrom('account:A');
      assert.deepEqual(cc(), [], 'nor does switching back');
    } finally { await close(); }
  });

  test('after undo send, a From switch replaces the first account\'s automatic Bcc with the second\'s', async () => {
    const accounts = [account('A', { bcc: ['a-arch@example.invalid'] }), account('B', { bcc: ['b-arch@example.invalid'] })];
    const close = await sendAndUndo({ to: ['x@example.invalid'], subject: 'Plan' }, { accounts });
    try {
      assert.deepEqual(chips('compose.bcc'), ['a-arch@example.invalid'], 'reopened as it was sent');
      await chooseFrom('account:B');
      assert.deepEqual(chips('compose.bcc'), ['b-arch@example.invalid']);
    } finally { await close(); }
  });

  test('after undo send of a reply, Reply All and back to Reply keeps the automatic Bcc', async () => {
    const close = await sendAndUndo(reply([{ name: '', email: 'thread@example.invalid' }]), { accounts: [account('A', { bcc: [ME] })] });
    try {
      assert.deepEqual(chips('compose.bcc'), [ME], 'reopened as it was sent');
      await switchReplyType('compose.replyAll');
      await switchReplyType('compose.reply');
      assert.deepEqual(chips('compose.bcc'), [ME]);
    } finally { await close(); }
  });

  test('after undo send, a From switch made while the message was being sent does not change what it reopens with', async () => {
    const accounts = [account('A', { cc: ['crm-a@example.invalid'] }), account('B', { cc: ['crm-b@example.invalid'] })];
    const cc = () => chips('compose.cc') ?? [];
    // The server has not answered yet, and From stays usable while it is sending.
    const close = await sendAndUndo({ to: ['x@example.invalid'], subject: 'Plan' }, { accounts, whileSending: () => chooseFrom('account:B') });
    try {
      assert.deepEqual(cc(), ['crm-a@example.invalid'], 'reopened as it was sent, from A');
      await chooseFrom('account:B');
      assert.deepEqual(cc(), ['crm-b@example.invalid'], 'B\'s automatic Cc replaces A\'s');
    } finally { await close(); }
  });

  test('after undo send of a message autosaved before Send, a From switch still swaps the automatic Cc', async () => {
    // A composer open for a while has saved a draft by the time Send is clicked. The undone message
    // comes back with that draft, but it was never opened from one, so it behaves like its composer.
    const accounts = [account('A', { cc: ['crm-a@example.invalid'] }), account('B', { cc: ['crm-b@example.invalid'] })];
    const close = await sendAndUndo({ to: ['x@example.invalid'], subject: 'Plan' }, {
      accounts,
      beforeSend: async () => {
        await editBody('Hi');
        await hideTab();
        assert.equal(saved.length, 1, 'precondition: the message was autosaved before Send');
      },
    });
    try {
      assert.equal(useStore.getState().composeData.draftUid, 8, 'reopened with its draft');
      assert.deepEqual(chips('compose.cc'), ['crm-a@example.invalid']);
      await chooseFrom('account:B');
      assert.deepEqual(chips('compose.cc'), ['crm-b@example.invalid']);
    } finally { await close(); }
  });

  test('a message undone after an autosave closes like its composer once saved again: without a discard prompt', async () => {
    const close = await sendAndUndo({ to: ['x@example.invalid'], subject: 'Plan' }, {
      accounts: [account('A')],
      beforeSend: async () => { await editBody('Hi'); await hideTab(); },
    });
    try {
      await hideTab(); // the reopened message is newer than its draft, so it is saved
      assert.equal(saved.length, 2, 'precondition: saved again after it was reopened');
      await click(document.querySelector('button[title="compose.toolbar.close"]'));
      assert.equal(useStore.getState().composing, false, 'closed, keeping the draft it saved');
    } finally { await close(); }
  });

  test('after undo send of a draft opened from the list, a From switch still adds no automatic Bcc', async () => {
    // The other side of the two tests above: this one was opened from a draft, so it stays one.
    const accounts = [account('A', { bcc: ['a-arch@example.invalid'] }), account('B', { bcc: ['b-arch@example.invalid'] })];
    const close = await sendAndUndo(
      { accountId: 'A', draftUid: 7, draftFolder: 'Drafts', to: ['x@example.invalid'], subject: 'Plan', body: '<p>Plan</p>' },
      { accounts },
    );
    try {
      assert.equal(useStore.getState().composeData.draftUid, 7, 'reopened with its draft');
      assert.equal(chips('compose.bcc'), null, 'no Bcc row: the draft saved none');
      await chooseFrom('account:B');
      assert.equal(chips('compose.bcc'), null, 'nor from the account From switches to');
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

describe('Reply with AI', () => {
  const ANA = { name: 'Ana', email: 'ana@example.invalid' };
  const thread = [
    { id: 'm1', message_id: '<m1@example.invalid>', thread_id: '<m1@example.invalid>', date: '2026-10-01T10:00:00Z', from_name: 'Ana', from_email: ANA.email },
    { id: 'm2', message_id: '<m2@example.invalid>', thread_id: '<m1@example.invalid>', date: '2026-10-02T10:00:00Z', from_name: 'Me', from_email: 'me@example.invalid' },
    { id: 'm3', message_id: '<m3@example.invalid>', thread_id: '<m1@example.invalid>', date: '2026-10-03T10:00:00Z', from_name: 'Ana', from_email: ANA.email },
  ];
  const bodies = {
    m1: { text: 'Here is the artwork for the new box.' },
    m2: { text: 'Could the logo be bigger?\n\nOn Thu, Ana wrote:\n> Here is the artwork for the new box.' },
    m3: { text: 'Done, the logo is bigger now. Can you approve?' },
  };
  const real = {};
  const chats = [];
  const purposes = [];
  let refusal = null;
  let threadLoads = 0;
  let answer = '';
  let unmount;

  const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text);
  const press = (el) => React.act(async () => { el.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })); });
  const click = (el) => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  const instructionField = () => document.querySelector('input[aria-label="compose.toolbar.aiReplyInstruction"]');
  async function typeInto(input, text) {
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    await React.act(async () => {
      setValue.call(input, text);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  }
  async function openAiMenu() {
    await press(document.querySelector('button[title="compose.toolbar.aiAssist"]'));
  }
  async function mount(composeData) {
    useStore.setState({ plaintextEmail: false, composing: false, composeData: null });
    useStore.getState().openCompose(composeData);
    const root = createRoot(document.getElementById('root'));
    await React.act(async () => { root.render(React.createElement(ComposeModal)); });
    await React.act(async () => {});
    unmount = () => React.act(async () => root.unmount());
  }

  before(() => {
    Object.assign(real, { status: api.ai.status, chat: api.ai.chat, getThread: api.getThread, getMessageBody: api.getMessageBody, resolveMessage: api.resolveMessage });
    api.ai.status = async () => ({ enabled: true, features: { compose: true, summarize: true } });
    api.ai.chat = async (messages, { purpose, onDelta } = {}) => {
      chats.push(messages);
      purposes.push(purpose);
      if (refusal) throw Object.assign(new Error('refused'), { status: 403, code: refusal });
      onDelta?.(answer.slice(0, 5));
      return answer;
    };
    api.getThread = async () => { threadLoads++; return { messages: thread }; };
    api.getMessageBody = async (id) => bodies[id];
    api.resolveMessage = async (ref) => thread.find(m => m.message_id === ref) ?? null;
    useStore.setState({
      user: { id: 'u1' },
      accounts: [{ id: 'acct', enabled: true, email_address: 'me@example.invalid', name: 'Me', color: '#fff' }],
    });
  });
  after(() => {
    api.ai.status = real.status;
    api.ai.chat = real.chat;
    api.getThread = real.getThread;
    api.getMessageBody = real.getMessageBody;
    api.resolveMessage = real.resolveMessage;
  });

  describe('in a reply', () => {
    // Opened the way a reply from the ungrouped list is: without the thread id, which that list
    // does not load.
    before(() => mount({
      accountId: 'acct', isReply: true, subject: 'Re: Artwork', body: '', cc: [],
      to: [ANA], originalFrom: [ANA], inReplyTo: '<m3@example.invalid>',
      quotedBody: '\n\n---\nOn 10/3/2026, Ana wrote:\n> Done, the logo is bigger now. Can you approve?',
      quotedBodyHtml: '<div><p>Done, the logo is bigger now. Can you approve?</p></div>',
    }));
    after(() => unmount());

    test('writes the reply from the conversation and the instruction', async () => {
      await openAiMenu();
      assert.equal(button('compose.toolbar.aiWriteDraft'), undefined, 'a reply offers Reply with AI, not a draft that ignores the conversation');
      await press(button('compose.toolbar.aiReply'));
      assert.equal(chats.length, 0, 'nothing is asked before the instruction is given');
      await typeInto(instructionField(), 'approve it');
      answer = 'Hi Ana,\n\nApproved, thank you.';
      await click(button('compose.toolbar.aiReplyGenerate'));
      await React.act(async () => {});

      assert.equal(chats.length, 1);
      const request = chats[0].map(m => m.content).join('\n');
      assert.match(request, /Here is the artwork for the new box\./);
      assert.match(request, /From: Me <me@example\.invalid> \(the user\)\n[\s\S]*Could the logo be bigger\?/);
      assert.match(request, /\(the one being answered\)[\s\S]*Can you approve\?/);
      assert.match(request, /Instruction for the reply: approve it$/);
      assert.equal(purposes.at(-1), 'summarize', 'asked for under summaries: it sends received mail');
      assert.match(document.body.textContent, /Approved, thank you\./, 'the suggestion is shown');
    });

    test('Apply puts the reply in the editor and keeps the quoted message', async () => {
      await click(button('compose.toolbar.aiApply'));
      const editor = document.querySelector('.ProseMirror').editor;
      assert.equal(editor.getHTML(), '<p>Hi Ana,</p><p></p><p>Approved, thank you.</p>', 'the blank line between paragraphs is kept');
      assert.equal(instructionField(), null, 'the panel closes');
      assert.match(document.body.textContent, /Done, the logo is bigger now\. Can you approve\?/, 'the quoted original is still there');
    });

    test('rewording the instruction asks again without reloading the conversation', async () => {
      await openAiMenu();
      await press(button('compose.toolbar.aiReply'));
      await typeInto(instructionField(), 'approve it');
      await click(button('compose.toolbar.aiReplyGenerate'));
      await React.act(async () => {});
      await typeInto(instructionField(), 'approve it, and ask for the print date');
      await click(button('message.aiRegenerate'));
      await React.act(async () => {});
      assert.equal(chats.length, 3);
      assert.match(chats[2][1].content, /Instruction for the reply: approve it, and ask for the print date$/);
      assert.equal(threadLoads, 1, 'the conversation was read once');
    });

    test('markup in the suggestion stays text, so an email cannot put a link into the reply', async () => {
      answer = 'Approved. Pay at <a href="https://evil.example">the portal</a>.';
      await click(button('message.aiRegenerate'));
      await React.act(async () => {});
      await click(button('compose.toolbar.aiApply'));
      const editor = document.querySelector('.ProseMirror').editor;
      assert.equal(document.querySelectorAll('.ProseMirror a').length, 0, 'no link was created');
      assert.equal(editor.getText(), 'Approved. Pay at <a href="https://evil.example">the portal</a>.');
    });
  });

  describe('on a conversation too long for one request', () => {
    let realBody;
    before(async () => {
      realBody = api.getMessageBody;
      // The message being answered alone is longer than one AI request.
      api.getMessageBody = async (id) => (id === 'm3' ? { text: 'A clause of the contract.\n\n'.repeat(3_000) } : bodies[id]);
      await mount({
        accountId: 'acct', isReply: true, subject: 'Re: Artwork', body: '', cc: [],
        to: [ANA], originalFrom: [ANA], inReplyTo: '<m3@example.invalid>',
      });
    });
    after(async () => {
      await unmount();
      api.getMessageBody = realBody;
    });

    test('tells the model what was cut, and says under the suggestion that it is partial', async () => {
      await openAiMenu();
      await press(button('compose.toolbar.aiReply'));
      answer = 'Hi Ana,\n\nApproved.';
      await click(button('compose.toolbar.aiReplyGenerate'));
      await React.act(async () => {});
      const request = chats.at(-1)[1].content;
      assert.ok(request.length <= 32_000, `${request.length}`);
      assert.match(request, /\[Only the first \d+ of \d+ characters of this message are included/);
      assert.match(document.body.textContent, /compose\.toolbar\.aiReplyPartial/);
    });
  });

  describe("opened by the message view's Reply with AI", () => {
    const opened = {
      accountId: 'acct', isReply: true, aiReply: true, subject: 'Re: Artwork', body: '', cc: [],
      to: [ANA], originalFrom: [ANA], inReplyTo: '<m3@example.invalid>',
      quotedBody: '\n\n---\nOn 10/3/2026, Ana wrote:\n> Done, the logo is bigger now. Can you approve?',
    };
    const stubs = {};
    let asked;
    before(async () => {
      asked = chats.length;
      Object.assign(stubs, { post: api.post, cancelSend: api.cancelSend, getSendStatus: api.getSendStatus });
      api.post = async () => ({ ok: true, pending: true, pendingId: 'p-ai', sendAt: new Date(Date.now() + 10_000).toISOString(), remainingMs: 10_000 });
      api.cancelSend = async () => ({ cancelled: true });
      api.getSendStatus = async () => ({ status: 'pending' });
      useStore.setState({ user: { id: 'u1' }, notifications: [] });
      await mount(opened);
    });
    after(async () => {
      await unmount();
      Object.assign(api, stubs);
    });

    test('opens with the instruction field ready, and the focus in it', async () => {
      assert.ok(instructionField(), 'the panel is open');
      // Compared by label: a failed comparison of two elements would print the whole DOM.
      assert.equal(document.activeElement?.getAttribute('aria-label'), 'compose.toolbar.aiReplyInstruction', 'typing goes to the instruction, not the reply');
      assert.equal(chats.length, asked, 'nothing is asked before the instruction is given');
    });

    test('a message reopened by Undo does not open the panel again', async () => {
      const editor = document.querySelector('.ProseMirror').editor;
      await React.act(async () => { editor.commands.setContent('<p>Approved.</p>'); });
      await click(button('compose.send'));
      await React.act(async () => {});
      const undo = useStore.getState().notifications.find(n => n.onUndo);
      assert.ok(undo, 'the send is held with Undo');
      await React.act(async () => { await undo.onUndo(); });
      const reopened = useStore.getState().composeData;
      assert.equal(reopened.restored, true, 'precondition: the message was reopened');
      assert.equal(reopened.aiReply, undefined);
    });
  });

  describe('with a signature', () => {
    let accountsBefore;
    before(async () => {
      accountsBefore = useStore.getState().accounts;
      useStore.setState({ accounts: [{ id: 'acct', enabled: true, email_address: 'me@example.invalid', name: 'Me', sender_name: 'Jordan Lee', color: '#fff', signature: '<p>Jordan Lee<br>Purchasing</p>' }] });
      await mount({
        accountId: 'acct', isReply: true, subject: 'Re: Artwork', body: '', cc: [],
        to: [ANA], originalFrom: [ANA], inReplyTo: '<m3@example.invalid>',
      });
    });
    after(async () => {
      await unmount();
      useStore.setState({ accounts: accountsBefore });
    });
    const ask = async () => {
      await openAiMenu();
      await press(button('compose.toolbar.aiReply'));
      await click(button('compose.toolbar.aiReplyGenerate'));
      await React.act(async () => {});
      return chats.at(-1)[0].content;
    };

    test('leaves the closing to the signature the composer adds', async () => {
      assert.match(await ask(), /Do not add a signature/);
    });

    test('signs with the sender\'s name once the signature is turned off for this message', async () => {
      await click(document.querySelector('button[title="compose.insertSignature"]'));
      assert.equal(document.querySelector('button[title="compose.insertSignature"]').getAttribute('aria-pressed'), 'false', 'precondition: the signature is off');
      assert.match(await ask(), /Sign off with the name Jordan Lee\./);
    });
  });

  describe('in a new message', () => {
    before(() => mount({ accountId: 'acct', to: ['Bob <bob@example.invalid>'], cc: [], subject: 'Quote', body: '' }));
    after(() => unmount());
    const draftField = () => document.querySelector('input[aria-label="compose.toolbar.aiWriteInstruction"]');

    test('Reply with AI is not offered, since there is nothing to reply to', async () => {
      await openAiMenu();
      assert.ok(button('compose.toolbar.aiWriteDraft'), 'the AI menu is open');
      assert.equal(button('compose.toolbar.aiReply'), undefined);
    });

    test('Write draft asks what to write before it writes anything', async () => {
      const asked = chats.length;
      await press(button('compose.toolbar.aiWriteDraft'));
      assert.ok(draftField(), 'the instruction field is open');
      assert.equal(document.activeElement?.getAttribute('aria-label'), 'compose.toolbar.aiWriteInstruction', 'and has the focus');
      assert.equal(chats.length, asked, 'nothing is asked yet');
      await typeInto(draftField(), 'ask for a quote for 500 boxes');
      answer = 'Hi Bob,\n\nCould you send a quote for 500 boxes?\n\nThanks';
      await click(button('compose.toolbar.aiReplyGenerate'));
      await React.act(async () => {});
      const request = chats.at(-1).map(m => m.content).join('\n');
      assert.match(request, /Subject: Quote\nTo: Bob <bob@example\.invalid>/);
      assert.match(request, /Instruction for the email: ask for a quote for 500 boxes$/);
      assert.equal(purposes.at(-1), 'compose', 'asked for under the writing assistant');
    });

    test('Apply keeps the blank lines between paragraphs', async () => {
      await click(button('compose.toolbar.aiApply'));
      const editor = document.querySelector('.ProseMirror').editor;
      assert.equal(editor.getHTML(), '<p>Hi Bob,</p><p></p><p>Could you send a quote for 500 boxes?</p><p></p><p>Thanks</p>');
    });

    test('says so when the administrator has turned AI off for the user', async () => {
      await openAiMenu();
      await press(button('compose.toolbar.aiWriteDraft'));
      refusal = 'ai_user_disabled';
      try {
        await click(button('compose.toolbar.aiReplyGenerate'));
        await React.act(async () => {});
      } finally { refusal = null; }
      assert.match(document.body.textContent, /compose\.toolbar\.aiNotAllowed/);
    });

    test('with the field left empty, it writes from the subject on its own', async () => {
      await openAiMenu();
      await press(button('compose.toolbar.aiWriteDraft'));
      await click(button('compose.toolbar.aiReplyGenerate'));
      await React.act(async () => {});
      assert.match(chats.at(-1)[1].content, /Instruction for the email: Write a suitable email for this subject\.$/);
    });
  });
});

describe('pasting text copied from an email', () => {
  // What Chrome puts on the clipboard for a phrase copied out of an email shown as sent: the
  // words wrapped in the frame's white page and #1a1a1a text. utils/editorPaste.editor.test.js
  // covers the other shapes a copy takes; this checks the composer is wired to drop the colors.
  const COPIED = `<meta charset='utf-8'><span style="color: rgb(26, 26, 26); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(255, 255, 255); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial; display: inline !important; float: none;">ice resurfacer is booked for</span>`;
  const Host = () => (useStore(s => s.composing) ? React.createElement(ComposeModal) : null);
  const posted = [];
  let unmount;
  before(async () => {
    useStore.setState({
      plaintextEmail: false, notifications: [], composing: false, composeData: null,
      accounts: [{ id: 'acct', enabled: true, email_address: 'me@example.invalid', name: 'Me', color: '#fff' }],
    });
    api.post = async (path, payload) => { posted.push({ path, payload }); return { ok: true }; };
    useStore.getState().openCompose({ accountId: 'acct', to: ['Bob <bob@example.invalid>'], cc: [], subject: 'Rink', body: '' });
    const root = createRoot(document.getElementById('root'));
    await React.act(async () => { root.render(React.createElement(Host)); });
    await React.act(async () => {});
    unmount = () => React.act(async () => root.unmount());
  });
  after(() => unmount());

  test('the message is sent without the colors of the email the text came from', async () => {
    const editor = document.querySelector('.ProseMirror').editor;
    // An explicit event, because jsdom has no ClipboardEvent for prosemirror-view to construct.
    await React.act(async () => { editor.view.pasteHTML(COPIED, new window.Event('paste')); });
    const send = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'compose.send');
    await React.act(async () => { send.click(); });
    await React.act(async () => {});
    assert.equal(posted.length, 1);
    assert.equal(posted[0].path, '/mail/send');
    assert.match(posted[0].payload.body, /ice resurfacer is booked for/);
    assert.doesNotMatch(posted[0].payload.body, /background-color|(?<![\w-])color\s*:/);
  });
});

describe('pasting into the signature and the quoted message', () => {
  // What Chrome puts on the clipboard for two paragraphs copied out of the message pane: each <p>
  // carries the email frame's white page and #1a1a1a text. utils/contentEditablePaste.test.js
  // covers the other shapes a copy takes; this checks both areas are wired to drop the colors.
  const PAGE = 'color: rgb(26, 26, 26); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(255, 255, 255); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;';
  const COPIED = `<meta charset='utf-8'><p id="p1" style="${PAGE}">Hi Marty,</p><p id="p2" style="${PAGE}">The ice resurfacer is booked.</p>`;
  const Host = () => (useStore(s => s.composing) ? React.createElement(ComposeModal) : null);
  const posted = [];

  // jsdom has no editing, so this stands in for the browser twice: insertHTML puts its HTML at
  // the caret and fires input, and a paste the page does not cancel inserts the clipboard's HTML
  // as it is, which is what the browser's own paste keeps of the colors.
  function insertAtCaret(target, html) {
    const selection = window.getSelection();
    let range = selection.rangeCount ? selection.getRangeAt(0) : null;
    if (!range || !target.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(false);
    }
    range.deleteContents();
    range.insertNode(range.createContextualFragment(html));
    target.dispatchEvent(new window.Event('input', { bubbles: true }));
  }
  function paste(target, html) {
    document.execCommand = (command, showUi, value) => {
      if (command !== 'insertHTML') return false;
      insertAtCaret(target, value);
      return true;
    };
    try {
      const event = new window.Event('paste', { bubbles: true, cancelable: true });
      event.clipboardData = { getData: type => (type === 'text/html' ? html : '') };
      target.dispatchEvent(event);
      if (!event.defaultPrevented) insertAtCaret(target, html);
    } finally {
      delete document.execCommand;
    }
  }

  // Opens a reply with a signature and a quoted message, pastes the copy into both, and sends it.
  // Returns the payload the server was sent.
  async function pasteAndSend({ phone }) {
    posted.length = 0;
    useStore.setState({
      plaintextEmail: false, notifications: [], composing: false, composeData: null,
      accounts: [{ id: 'acct', enabled: true, email_address: 'me@example.invalid', name: 'Me', color: '#fff', signature: '<p>Marty Example</p>' }],
    });
    api.post = async (path, payload) => { posted.push({ path, payload }); return { ok: true }; };
    useStore.getState().openCompose({
      accountId: 'acct', isReply: true, to: ['Bob <bob@example.invalid>'], cc: [], subject: 'Re: Rink', body: '',
      quotedBodyHtml: '<p>Original message</p>',
    });
    const width = window.innerWidth;
    if (phone) Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 375 });
    const root = createRoot(document.getElementById('root'));
    try {
      await React.act(async () => { root.render(React.createElement(Host)); });
      await React.act(async () => {});
      const buttons = () => [...document.querySelectorAll('button')];
      // Only the phone layout shows Reply and Reply All side by side.
      assert.equal(buttons().some(b => b.textContent === 'compose.replyAll'), phone, 'precondition: the layout under test is rendered');
      const editable = (text) => [...document.querySelectorAll('[contenteditable]')].find(el => el.textContent.includes(text));
      const signature = editable('Marty Example');
      const quoted = editable('Original message');
      assert.ok(signature && quoted, 'precondition: the signature and the quoted message are editable');
      await React.act(async () => { paste(signature, COPIED); });
      await React.act(async () => { paste(quoted, COPIED); });
      await React.act(async () => { buttons().find(b => b.textContent.trim() === 'compose.send').click(); });
      await React.act(async () => {});
      assert.equal(posted.length, 1);
      return posted[0].payload;
    } finally {
      await React.act(async () => root.unmount());
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
    }
  }

  function assertNoCopiedColor({ editedSignature, quotedBodyHtml }) {
    for (const [name, html] of [['signature', editedSignature], ['quoted message', quotedBodyHtml]]) {
      assert.match(html, /The ice resurfacer is booked\./, `the paste reached the ${name}`);
      assert.doesNotMatch(html, /background-color|(?<![\w-])color\s*:/, `the ${name} carries no copied color`);
    }
  }

  test('the reply is sent without the colors of the email the text came from', async () => {
    assertNoCopiedColor(await pasteAndSend({ phone: false }));
  });

  test('and so it is from the phone layout, which has its own quoted message', async () => {
    assertNoCopiedColor(await pasteAndSend({ phone: true }));
  });
});

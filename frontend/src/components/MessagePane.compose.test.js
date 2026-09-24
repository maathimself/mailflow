// Characterization test for the reply / reply-all / forward drafts MessagePane builds.
//
// Written BEFORE moving that logic onto the shared composeFromMessage util, so the payload
// handed to openCompose is pinned exactly as it is today. If the move changes so much as a
// quoting character, a header chain or an alias, these fail. That is the whole point: this
// file is the evidence that the refactor was behavior-preserving, not a description of what
// the draft ought to look like.
//
// Reply actions use shortcutBus. Forward uses the pane's own toolbar button: the selected-row
// shortcut belongs to MessageList, which is not mounted in this isolated pane test.

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
  getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.requestAnimationFrame ??= cb => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame ??= id => clearTimeout(id);
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const BODY = {
  html: '<p>Original &amp; body</p>',
  text: 'Original & body\nsecond line',
  attachments: [{ part: '2', filename: 'report.pdf', type: 'application/pdf', size: 1234 }],
};
globalThis.fetch = async (url) => {
  const u = String(url);
  if (/\/messages\/[^/]+\/body/.test(u)) return { ok: true, status: 200, json: async () => BODY, text: async () => '' };
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { shortcutBus } = await import('../utils/shortcutBus.js');
const MessagePane = (await import('./MessagePane.jsx')).default;

// A message that exercises every branch worth pinning: a Reply-To that overrides the
// sender, an alias matched through Delivered-To, other recipients for reply-all, one of
// the reader's own addresses among them (which must be dropped), and a References chain.
const MSG = {
  id: 'm1',
  account_id: 'acct',
  folder: 'INBOX',
  uid: 7,
  subject: 'Quarterly numbers',
  from_email: 'sender@out.example',
  from_name: 'Sam Sender',
  reply_to: [{ name: 'Desk', email: 'desk@out.example' }],
  to_addresses: [
    { name: 'Me', email: 'me@mine.example' },
    { name: 'Other', email: 'other@out.example' },
  ],
  cc_addresses: [{ name: 'Cc Person', email: 'cc@out.example' }],
  delivery_addresses: ['team@mine.example'],
  message_id: '<msg1@out.example>',
  in_reply_to: '<parent@out.example>',
  thread_id: 'thread-42',
  date: '2026-03-04T09:30:00.000Z',
  is_read: true,
};

const ACCOUNT = {
  id: 'acct',
  enabled: true,
  email_address: 'me@mine.example',
  color: '#fff',
  aliases: [
    { id: 'alias-team', email: 'team@mine.example' },
    { id: 'alias-other', email: 'other@mine.example' },
  ],
};

let drafts = [];
let root;

before(async () => {
  useStore.getState().setUser({ id: 'u1' });
  useStore.getState().setLocked(false);
  useStore.getState().setAccounts([ACCOUNT]);
  useStore.getState().setMessages([MSG]);
  useStore.setState({
    openCompose: (draft) => drafts.push(draft),
    messageWindows: [{ winId: 'test-window', messageId: 'm1', z: 1, minimized: false }],
  });
  useStore.getState().setSelectedMessage('m1');
  root = createRoot(document.getElementById('root'));
  // Detached windows have no MessageList; the pane owns its toolbar actions.
  await React.act(async () => { root.render(React.createElement(MessagePane, { windowMessageId: 'm1' })); });
  // Let the body load, since the quoted text is built from it.
  await React.act(async () => { await new Promise(r => setTimeout(r, 60)); });
});
after(async () => { await React.act(async () => root.unmount()); });

const emit = async (action) => {
  drafts = [];
  await React.act(async () => {
    if (action === 'forward') {
      const button = document.querySelector('button[title^="message.forward"]');
      assert.ok(button, 'pane forward button is available');
      button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    } else {
      shortcutBus.emit(action);
    }
  });
  await React.act(async () => { await new Promise(r => setTimeout(r, 20)); });
  assert.equal(drafts.length, 1, `${action} opened exactly one composer`);
  return drafts[0];
};

const DATE_STR = new Date(MSG.date).toLocaleString();

describe('reply', () => {
  test('addresses the Reply-To, not the From', async () => {
    const draft = await emit('reply');
    assert.deepEqual(draft.to, [{ name: 'Desk', email: 'desk@out.example' }]);
    assert.deepEqual(draft.originalFrom, [{ name: 'Desk', email: 'desk@out.example' }]);
  });

  test('a plain reply carries no Cc', async () => {
    const draft = await emit('reply');
    assert.deepEqual(draft.cc, []);
  });

  test('threads the reply with In-Reply-To, References and the thread id', async () => {
    const draft = await emit('reply');
    assert.equal(draft.inReplyTo, '<msg1@out.example>');
    assert.equal(draft.references, '<parent@out.example> <msg1@out.example>');
    assert.equal(draft.threadId, 'thread-42');
  });

  test('picks the alias the mail was delivered to', async () => {
    // team@mine.example appears only in Delivered-To, never in To or Cc.
    const draft = await emit('reply');
    assert.equal(draft.aliasId, 'alias-team');
  });

  test('prefixes the subject once', async () => {
    const draft = await emit('reply');
    assert.equal(draft.subject, 'Re: Quarterly numbers');
  });

  test('quotes the original as text and as html', async () => {
    const draft = await emit('reply');
    assert.equal(
      draft.quotedBody,
      `\n\n---\nOn ${DATE_STR}, Sam Sender <sender@out.example> wrote:\n> Original & body\n> second line`,
    );
    assert.match(draft.quotedBodyHtml, /On .*, Sam Sender &lt;sender@out\.example&gt; wrote:|On .*, Sam Sender <sender@out\.example> wrote:/);
    assert.match(draft.quotedBodyHtml, /<p>Original &amp; body<\/p>/);
    assert.equal(draft.body, '', 'the cursor starts in an empty draft above the quote');
  });

  test('is flagged as a reply', async () => {
    const draft = await emit('reply');
    assert.equal(draft.isReply, true);
    assert.equal(draft.isReplyAll, false);
    assert.equal(draft.accountId, 'acct');
  });
});

describe('reply all', () => {
  test('ccs the other recipients but never the reader or the reply target', async () => {
    const draft = await emit('replyAll');
    assert.deepEqual(draft.cc, [
      { name: 'Other', email: 'other@out.example' },
      { name: 'Cc Person', email: 'cc@out.example' },
    ], 'me@mine.example is dropped as the reader, desk@out.example as the reply target');
    assert.equal(draft.isReplyAll, true);
  });

  test('still addresses only the reply target', async () => {
    const draft = await emit('replyAll');
    assert.deepEqual(draft.to, [{ name: 'Desk', email: 'desk@out.example' }]);
  });
});

describe('forward', () => {
  test('prefixes the subject and carries the attachments', async () => {
    const draft = await emit('forward');
    assert.equal(draft.subject, 'Fwd: Quarterly numbers');
    assert.equal(draft.isForward, true);
    assert.deepEqual(draft.forwardedAttachments, [
      { messageId: 'm1', part: '2', filename: 'report.pdf', type: 'application/pdf', size: 1234 },
    ]);
  });

  test('builds the forwarded header block', async () => {
    const draft = await emit('forward');
    assert.equal(
      draft.quotedBody,
      '\n\n---------- Forwarded message ----------\n'
      + 'From: Sam Sender <sender@out.example>\n'
      + `Date: ${DATE_STR}\n`
      + 'Subject: Quarterly numbers\n'
      + 'To: Me <me@mine.example>, Other <other@out.example>\n'
      + 'Cc: Cc Person <cc@out.example>\n\n'
      + 'Original & body\nsecond line',
    );
    assert.match(draft.quotedBodyHtml, /---------- Forwarded message ----------/);
    assert.match(draft.quotedBodyHtml, /<p>Original &amp; body<\/p>/);
  });
});

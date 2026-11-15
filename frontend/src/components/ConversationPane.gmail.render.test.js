// Render test for how a long conversation reads in the Gmail layout, each behavior checked to be
// absent in the other layouts too.
//
// Same loader hooks as ConversationPane.render.test.js.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k, o) => (o && "count" in o ? `${k}:${o.count}` : k), i18n: { language: "en", changeLanguage: () => {} } });',
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
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.requestAnimationFrame ??= cb => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame ??= id => clearTimeout(id);
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const ME = { email: 'me@x.z', name: 'Me' };
const ANA = { email: 'a@x.z', name: 'Ana' };
const BO = { email: 'bo@x.z', name: 'Bo' };
const message = (n, extra = {}) => ({
  id: `m${n}`, account_id: 'acct', folder: 'INBOX', message_id: `<${n}@x>`, subject: n === 1 ? 'Plans' : 'Re: Plans',
  from_email: ANA.email, from_name: ANA.name, to_addresses: JSON.stringify([ME]), cc_addresses: '[]',
  date: `2026-01-0${n}T10:00:00Z`, is_read: true, snippet: `snippet ${n}`, ...extra,
});
const threadOf = (count, extra = {}) => Array.from({ length: count }, (_, i) => message(i + 1, extra[i + 1]));

let thread = threadOf(7);
// What a body request serves, by message id; the rest get a short HTML body.
let bodies = {};
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/mail/thread?')) return { ok: true, status: 200, json: async () => ({ messages: thread }) };
  const id = /\/messages\/([^/]+)\/body/.exec(u)?.[1];
  if (id) return { ok: true, status: 200, json: async () => (bodies[id] ?? { html: `<p>body of ${id}</p>`, text: '', attachments: [] }) };
  return { ok: true, status: 200, json: async () => ({}) };
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const ConversationPane = (await import('./ConversationPane.jsx')).default;
const { useStore } = await import('../store/index.js');
const { bodyCache } = await import('../utils/bodyCache.js');
const { formatDateTime, formatMessageDateTime } = await import('../utils/formatDate.js');
const { senderColor } = await import('../themes.js');
const postcss = (await import('postcss')).default;

let root;
let mounts = 0;
before(() => {
  root = createRoot(document.getElementById('root'));
  useStore.setState({ darkEmailBodies: false, accounts: [{ id: 'acct', email_address: ME.email, aliases: [] }] });
});
after(async () => { await React.act(async () => root.unmount()); });
beforeEach(() => {
  bodyCache.clear();
  bodies = {};
  thread = threadOf(7);
  useStore.setState({ layout: 'gmail', messages: [], composing: false, composeData: null });
});

const settle = () => React.act(async () => { await new Promise(r => setTimeout(r, 50)); });
async function open(props = {}) {
  await React.act(async () => {
    root.render(React.createElement(ConversationPane, { key: `pane-${++mounts}`, threadId: '<1@x>', folder: 'INBOX', ...props }));
  });
  await settle();
}
const click = async (el) => { await React.act(async () => { el.click(); }); await settle(); };

const shownIds = () => [...document.querySelectorAll('[data-message-id]')].map(card => card.dataset.messageId);
const openIds = () => [...document.querySelectorAll('[data-message-id] > button[aria-expanded="true"]')]
  .map(button => button.closest('[data-message-id]').dataset.messageId);
const folds = () => [...document.querySelectorAll('.mail-conversation-fold')];
const toolbarButton = label => document.querySelector(`.mail-reader-toolbar button[aria-label="${label}"]`);
const replyButtons = () => [...document.querySelectorAll('.mail-conversation-replies button')].map(b => b.textContent);

describe('older messages fold', () => {
  test('with 5 or more, the collapsed ones between the first and the last two are one row', async () => {
    await open();
    assert.deepEqual(shownIds(), ['m1', 'm6', 'm7']);
    assert.equal(folds().length, 1);
    assert.equal(folds()[0].querySelector('.mail-conversation-fold-count').textContent, '4');
    assert.match(folds()[0].textContent, /message\.olderMessages:4/);
  });

  test('opening the row shows them as the usual collapsed cards', async () => {
    await open();
    await click(folds()[0]);
    assert.equal(folds().length, 0);
    assert.deepEqual(shownIds(), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
    assert.deepEqual(openIds(), ['m7']);
  });

  test('outside the Gmail layout nothing folds', async () => {
    useStore.setState({ layout: 'comfortable' });
    await open();
    assert.equal(folds().length, 0);
    assert.deepEqual(shownIds(), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
  });

  test('fewer than 5 messages fold nothing', async () => {
    thread = threadOf(4);
    await open();
    assert.equal(folds().length, 0);
    assert.deepEqual(shownIds(), ['m1', 'm2', 'm3', 'm4']);
  });

  test('an open message is never folded, and splits the fold around it', async () => {
    thread = threadOf(8, { 4: { is_read: false } });
    await open();
    assert.deepEqual(shownIds(), ['m1', 'm4', 'm7', 'm8']);
    assert.deepEqual(folds().map(f => f.querySelector('.mail-conversation-fold-count').textContent), ['2', '2']);
  });

  test('a reply that arrives folds nothing the reader opened or could see', async () => {
    const row = { id: 'm7', thread_id: '<1@x>', account_id: 'acct', folder: 'INBOX', message_count: 7, date: thread[6].date };
    useStore.setState({ messages: [row], searchQuery: '' });
    await open({ accountId: 'acct', selectedMessageId: 'm7', openedFromRow: true });
    await click(folds()[0]);
    thread = [...thread, message(8)];
    await React.act(async () => { useStore.setState({ messages: [{ ...row, id: 'm8', message_count: 8, date: thread[7].date }] }); });
    await settle();
    assert.equal(folds().length, 0, 'the opened fold stays open');
    assert.deepEqual(shownIds(), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8']);
  });

  test('a reply that arrives into a closed fold leaves the cards that were on show', async () => {
    const row = { id: 'm7', thread_id: '<1@x>', account_id: 'acct', folder: 'INBOX', message_count: 7, date: thread[6].date };
    useStore.setState({ messages: [row], searchQuery: '' });
    await open({ accountId: 'acct', selectedMessageId: 'm7', openedFromRow: true });
    thread = [...thread, message(8)];
    await React.act(async () => { useStore.setState({ messages: [{ ...row, id: 'm8', message_count: 8, date: thread[7].date }] }); });
    await settle();
    assert.deepEqual(shownIds(), ['m1', 'm6', 'm7', 'm8']);
    assert.equal(folds()[0].querySelector('.mail-conversation-fold-count').textContent, '4');
  });
});

describe('unread messages open', () => {
  test('the newest and every unread message open, of the row\'s account only', async () => {
    thread = threadOf(5, { 2: { is_read: false }, 3: { is_read: false, account_id: 'other' } });
    await open({ accountId: 'acct' });
    assert.deepEqual(openIds(), ['m2', 'm5']);
  });

  test('outside the Gmail layout only the newest opens', async () => {
    useStore.setState({ layout: 'comfortable' });
    thread = threadOf(5, { 2: { is_read: false } });
    await open();
    assert.deepEqual(openIds(), ['m5']);
  });
});

describe('Expand all and Collapse all', () => {
  test('Expand all opens every message, folded ones too; Collapse all leaves the newest open', async () => {
    await open();
    assert.equal(toolbarButton('message.collapseAll'), null);
    await click(toolbarButton('message.expandAll'));
    assert.equal(folds().length, 0);
    assert.deepEqual(openIds(), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
    assert.equal(toolbarButton('message.expandAll'), null);
    await click(toolbarButton('message.collapseAll'));
    assert.deepEqual(openIds(), ['m7']);
    assert.deepEqual(shownIds(), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'], 'what the reader opened is not folded again');
    assert.ok(toolbarButton('message.expandAll'));
  });

  test('outside the Gmail layout there is neither', async () => {
    useStore.setState({ layout: 'comfortable' });
    await open();
    assert.equal(toolbarButton('message.expandAll'), null);
    assert.equal(toolbarButton('message.collapseAll'), null);
  });

  test('a single message has neither', async () => {
    thread = threadOf(1);
    await open();
    assert.equal(toolbarButton('message.expandAll'), null);
    assert.equal(toolbarButton('message.collapseAll'), null);
  });
});

describe('trimmed quoted history', () => {
  const REPLY = '<div>Sure</div><div class="gmail_quote"><div class="gmail_attr">On 6 Jan 2026, Ana wrote:</div><blockquote>Lunch?</blockquote></div>';
  const frameDoc = () => document.querySelector('[data-message-id="m7"] iframe').getAttribute('srcdoc');

  test('an HTML body\'s trailing quote is behind a toggle in its frame', async () => {
    bodies.m7 = { html: REPLY, text: '', attachments: [] };
    await open();
    const { document: frame } = new JSDOM(frameDoc()).window;
    const details = frame.querySelector('#mf-scale-wrapper details.mf-trimmed');
    assert.ok(details);
    assert.equal(details.querySelector('.mf-trimmed-show').title, 'message.showTrimmed');
    assert.equal(details.querySelector('.mf-trimmed-hide').title, 'message.hideTrimmed');
  });

  test('a forward is shown whole', async () => {
    thread = threadOf(7, { 7: { subject: 'Fwd: Plans' } });
    bodies.m7 = { html: REPLY, text: '', attachments: [] };
    await open();
    assert.doesNotMatch(frameDoc(), /<details/);
  });

  test('a plain-text body\'s "> " lines are behind a toggle whose title follows it', async () => {
    bodies.m7 = { html: '', text: 'Sure\n\nOn 6 Jan 2026, Ana wrote:\n> Lunch?', attachments: [] };
    await open();
    const card = document.querySelector('[data-message-id="m7"]');
    const details = card.querySelector('details.mail-trimmed-text');
    assert.match(details.textContent, /> Lunch\?/);
    assert.doesNotMatch(card.textContent.replace(details.textContent, ''), /Lunch/);
    const summary = details.querySelector('summary');
    assert.equal(summary.textContent, '•••');
    assert.equal(summary.title, 'message.showTrimmed');
    await React.act(async () => {
      details.open = true;
      details.dispatchEvent(new window.Event('toggle'));
    });
    assert.equal(summary.title, 'message.hideTrimmed');
  });

  test('outside the Gmail layout the body is shown whole', async () => {
    useStore.setState({ layout: 'comfortable' });
    bodies.m7 = { html: REPLY, text: '', attachments: [] };
    await open();
    assert.doesNotMatch(frameDoc(), /<details/);
  });

  test('outside the Gmail layout a plain-text body is shown whole', async () => {
    useStore.setState({ layout: 'comfortable' });
    bodies.m5 = { html: '', text: 'Sure\n> Lunch?', attachments: [] };
    thread = threadOf(5);
    await open();
    assert.equal(document.querySelector('details'), null);
    assert.match(document.querySelector('[data-message-id="m5"]').textContent, /> Lunch\?/);
  });
});

describe('card dates', () => {
  const dates = () => [...document.querySelectorAll('.mail-conversation-sender > span:last-child')].map(el => el.textContent);

  test('open and closed cards are dated as the reader\'s header dates a message', async () => {
    thread = threadOf(3);
    await open();
    assert.deepEqual(dates(), thread.map(m => formatMessageDateTime(m.date)));
    assert.notEqual(dates()[0], formatDateTime(thread[0].date), 'not the long locale string');
  });

  test('outside the Gmail layout they keep the full date and time', async () => {
    useStore.setState({ layout: 'comfortable' });
    thread = threadOf(3);
    await open();
    assert.deepEqual(dates(), thread.map(m => formatDateTime(m.date)));
  });
});

describe('sender avatars', () => {
  const avatar = id => document.querySelector(`[data-message-id="${id}"] > .mail-conversation-sender > .mail-conversation-avatar`);
  const colorOf = value => { const el = document.createElement('div'); el.style.background = value; return el.style.background; };

  test('every card, open or closed, starts with the reader\'s letter avatar', async () => {
    thread = threadOf(3, { 2: { from_email: BO.email, from_name: BO.name } });
    await open();
    assert.deepEqual(openIds(), ['m3']);
    for (const [id, letter, email] of [['m1', 'A', ANA.email], ['m2', 'B', BO.email], ['m3', 'A', ANA.email]]) {
      const el = avatar(id);
      assert.ok(el, `${id} has an avatar`);
      assert.equal(el.parentElement.firstElementChild, el, 'at the left of the header');
      assert.equal(el.textContent, letter);
      assert.equal(el.style.background, colorOf(senderColor(email)));
      assert.equal(el.getAttribute('aria-hidden'), 'true', 'the name beside it is what is read out');
    }
  });

  test('the skin\'s name rules still reach the name, past the avatar', async () => {
    thread = threadOf(3);
    await open();
    const css = postcss.parse(readFileSync(new URL('../gmail-reader-compose.css', import.meta.url), 'utf8'));
    const nameSelectors = [];
    css.walkRules(rule => rule.selectors
      .filter(selector => /\.mail-conversation-sender > span/.test(selector))
      .forEach(selector => nameSelectors.push(selector.slice(selector.indexOf('.mail-conversation-card') >= 0
        ? selector.indexOf('.mail-conversation-card') : selector.indexOf('.mail-conversation-sender')))));
    assert.ok(nameSelectors.length >= 2);
    for (const selector of nameSelectors) {
      const matched = document.querySelector(selector);
      assert.equal(matched?.textContent, ANA.name, selector);
    }
  });

  test('outside the Gmail layout cards have no avatar', async () => {
    useStore.setState({ layout: 'comfortable' });
    thread = threadOf(3);
    await open();
    assert.equal(document.querySelector('.mail-conversation-avatar'), null);
  });
});

describe('reply row under the last message', () => {
  test('Reply and Forward, and no Reply all for a message to the reader alone', async () => {
    await open();
    assert.deepEqual(replyButtons(), ['message.reply', 'message.forward']);
    const stack = document.querySelector('.mail-conversation-stack');
    assert.equal(stack.lastElementChild.className, 'mail-conversation-replies', 'under the last message');
  });

  test('Reply all when the newest message has another recipient besides its sender', async () => {
    thread = threadOf(5, { 5: { cc_addresses: JSON.stringify([BO]) } });
    await open();
    assert.deepEqual(replyButtons(), ['message.reply', 'message.replyAll', 'message.forward']);
  });

  test('each acts on the newest message', async () => {
    thread = threadOf(5, { 5: { cc_addresses: JSON.stringify([BO]) } });
    await open();
    const [reply, replyAll, forward] = document.querySelectorAll('.mail-conversation-replies button');
    const closeCompose = () => useStore.setState({ composing: false, composeData: null });
    await click(reply);
    let data = useStore.getState().composeData;
    assert.equal(data.inReplyTo, '<5@x>');
    assert.deepEqual(data.to.map(a => a.email), [ANA.email]);
    assert.deepEqual(data.cc, []);
    closeCompose();
    await click(replyAll);
    data = useStore.getState().composeData;
    assert.equal(data.inReplyTo, '<5@x>');
    assert.deepEqual(data.cc.map(a => a.email), [BO.email]);
    closeCompose();
    await click(forward);
    data = useStore.getState().composeData;
    assert.match(data.subject, /^Fwd: Re: Plans/);
  });

  test('outside the Gmail layout there is no reply row', async () => {
    useStore.setState({ layout: 'comfortable' });
    await open();
    assert.equal(document.querySelector('.mail-conversation-replies'), null);
  });
});
